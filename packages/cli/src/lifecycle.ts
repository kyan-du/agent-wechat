import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_DIR,
  CONTAINER_NAME,
  DEFAULT_PORT,
  GHCR_IMAGE,
  TOKEN_PATH,
  assertSafePurgePath,
  createInventory,
  loadInventory,
  removeInventory,
  saveInventory,
  type InstanceInventory,
} from "./instance-inventory.js";
import type { DeviceIdentity } from "./device-identity.js";
import { buildDockerRunArgs } from "./device-identity.js";
import { validatePublishedImageReference } from "./image-reference.js";
import { CliError, EXIT } from "./exit-contract.js";
import {
  IMAGE_LABEL,
  INSTANCE_LABEL,
  VOLUME_ROLE_LABEL,
  hasOwnedContainer,
  hasOwnedVolume,
  isReconcileableContainer,
  type VolumeInspect,
} from "./lifecycle-policy.js";

export type DockerInspect = {
  Id: string;
  Image: string;
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[]; Hostname?: string };
  HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }> | null> };
  State?: { Running?: boolean; Health?: { Status?: string } };
  Mounts?: Array<{ Name?: string; Destination?: string; Type?: string; Source?: string }>;
  NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> };
};

function docker(args: string[], options: { inherit?: boolean } = {}): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    }) as string;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new CliError("DOCKER_FAILED", stderr || `docker ${args[0]} failed`, EXIT.ENVIRONMENT);
  }
}

export function dockerAvailable(): boolean {
  try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; }
}

export function inspectContainer(): DockerInspect | undefined {
  let ids: string;
  try {
    ids = execFileSync("docker", ["ps", "-aq", "-f", `name=^${CONTAINER_NAME}$`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    throw new CliError("DOCKER_INSPECT_FAILED", "cannot query Docker container state", EXIT.ENVIRONMENT);
  }
  if (!ids) return undefined;
  const parts = ids.split(/\s+/).filter(Boolean);
  if (parts.length !== 1 || !/^[a-f0-9]{12,64}$/.test(parts[0])) {
    throw new CliError("CONTAINER_ID_AMBIGUOUS", "container lookup was ambiguous", EXIT.ENVIRONMENT);
  }
  try {
    const raw = execFileSync("docker", ["inspect", parts[0]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = JSON.parse(raw) as DockerInspect[];
    if (parsed.length !== 1 || parsed[0].Id !== parts[0] && !parsed[0].Id.startsWith(parts[0])) throw new Error("inspect identity mismatch");
    return parsed[0];
  } catch {
    throw new CliError("CONTAINER_INSPECT_FAILED", "container exists but cannot be inspected", EXIT.ENVIRONMENT);
  }
}

function imageRepoDigest(reference: string): string | undefined {
  const raw = docker(["image", "inspect", reference, "--format", "{{json .RepoDigests}}"]).trim();
  const values = JSON.parse(raw) as string[];
  return values.find((value) => value.startsWith(`${GHCR_IMAGE}@sha256:`));
}

function imageExists(reference: string): boolean {
  try { execFileSync("docker", ["image", "inspect", reference], { stdio: "ignore" }); return true; } catch { return false; }
}

function inspectVolume(name: string): VolumeInspect | undefined {
  let raw: string;
  try {
    raw = execFileSync("docker", ["volume", "inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw new CliError("VOLUME_INSPECT_FAILED", `cannot inspect volume ${name}`, EXIT.ENVIRONMENT);
  }
  try {
    const parsed = JSON.parse(raw) as VolumeInspect[];
    if (parsed.length !== 1) throw new Error("ambiguous volume inspect");
    return parsed[0];
  } catch {
    throw new CliError("VOLUME_INSPECT_FAILED", `Docker returned invalid volume metadata for ${name}`, EXIT.ENVIRONMENT);
  }
}

function ensureOwnedVolumes(inventory: InstanceInventory): void {
  const roles = ["data", "wechat-home"] as const;
  for (const [index, name] of inventory.volumes.entries()) {
    const existing = inspectVolume(name);
    if (!existing) {
      docker(["volume", "create", "--driver", "local", "--label", `${INSTANCE_LABEL}=default`, "--label", `${VOLUME_ROLE_LABEL}=${roles[index]}`, name]);
      continue;
    }
    assertVolumeOwnership(existing, name, roles[index]);
  }
}

function assertVolumeOwnership(existing: VolumeInspect, name: string, role: "data" | "wechat-home"): void {
  if (!hasOwnedVolume(existing, name, role)) {
    throw new CliError("VOLUME_OWNERSHIP_MISMATCH", `refusing to use volume ${name} without trusted ownership`, EXIT.ENVIRONMENT);
  }
}

function assertOwnedVolumes(inventory: InstanceInventory): void {
  const roles = ["data", "wechat-home"] as const;
  for (const [index, name] of inventory.volumes.entries()) {
    const existing = inspectVolume(name);
    if (!existing) continue;
    assertVolumeOwnership(existing, name, roles[index]);
  }
}

function assertOwnedContainer(info: DockerInspect, inventory?: InstanceInventory): void {
  // Older releases did not label the fixed-name container. A trusted inventory
  // binding is sufficient to reconcile that legacy container; labels remain the
  // preferred identity for newly-created containers.
  if (!isReconcileableContainer(info, inventory)) throw new CliError("CONTAINER_OWNERSHIP_MISMATCH", "refusing to operate on an unowned container with the fixed name", EXIT.ENVIRONMENT);
}

export function clearContainerIdentity(inventory: InstanceInventory): void {
  const info = inspectContainer();
  if (!info) throw new CliError("INSTANCE_NOT_RUNNING", "trusted container is required to clear container identity", EXIT.CLEANUP);
  assertOwnedContainer(info, inventory);
  if (!info.State?.Running) docker(["start", info.Id]);
  try {
    docker(["exec", info.Id, "/opt/reset-device-identity.sh"]);
  } catch (error) {
    if (error instanceof CliError) throw new CliError("AUTH_RESET_IDENTITY_FAILED", "container identity cleanup failed closed", EXIT.CLEANUP);
    throw error;
  }
}

export function removeOwnedVolume(
  inventory: InstanceInventory,
  index: 0 | 1,
  role: "data" | "wechat-home",
): boolean {
  const name = inventory.volumes[index];
  const existing = inspectVolume(name);
  if (!existing) return false;
  assertVolumeOwnership(existing, name, role);
  docker(["volume", "rm", name]);
  return true;
}

export function resolveImage(options: {
  explicit?: string;
  pull?: boolean;
  noPull?: boolean;
  localDefault: string;
}): { runReference: string; requestedReference: string; digest?: string } {
  if (options.pull && options.noPull) throw new CliError("ARGUMENT_CONFLICT", "--pull and --no-pull are mutually exclusive", EXIT.ARGUMENT);
  const inventory = loadInventory();
  const requested = options.explicit ? validatePublishedImageReference(options.explicit) : inventory?.imageDigest || options.localDefault;
  const published = requested.startsWith(`${GHCR_IMAGE}:`) || requested.startsWith(`${GHCR_IMAGE}@`);
  if (options.pull) {
    if (!published) throw new CliError("IMAGE_NOT_PUBLISHED", "--pull requires a published fork image", EXIT.ARGUMENT);
    docker(["pull", requested], { inherit: true });
  } else if (!imageExists(requested)) {
    if (options.noPull || !options.explicit) {
      throw new CliError("COMPATIBLE_IMAGE_UNAVAILABLE", `compatible image ${requested} is unavailable offline`, EXIT.ENVIRONMENT);
    }
    docker(["pull", requested], { inherit: true });
  }
  const digest = published ? imageRepoDigest(requested) : undefined;
  if (published && !digest) throw new CliError("IMAGE_DIGEST_UNRESOLVED", "published image did not resolve to a fork repo digest", EXIT.ENVIRONMENT);
  return { runReference: digest || requested, requestedReference: requested, digest };
}

export async function waitCompatible(token: string, timeoutMs = 30_000): Promise<void> {
  await waitHealthy(timeoutMs);
  try {
    const response = await fetch(`http://localhost:${DEFAULT_PORT}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = response.ok ? await response.json() as { apiVersion?: unknown } : {};
    if (status.apiVersion !== 1) throw new Error("unsupported API version");
  } catch {
    throw new CliError("IMAGE_API_INCOMPATIBLE", "image health passed but API version is incompatible", EXIT.SERVICE);
  }
}

export async function waitHealthy(timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const response = await fetch(`http://localhost:${DEFAULT_PORT}/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new CliError("HEALTH_CHECK_FAILED", "service did not become healthy", EXIT.SERVICE);
}

export async function startInstance(options: {
  identity: DeviceIdentity;
  token: string;
  proxy?: string;
  outbound?: Record<string, string>;
  image?: string;
  pull?: boolean;
  noPull?: boolean;
  localDefault: string;
}): Promise<InstanceInventory> {
  if (!dockerAvailable()) throw new CliError("DOCKER_UNAVAILABLE", "Docker daemon is unavailable", EXIT.ENVIRONMENT);
  const existing = inspectContainer();
  const current = loadInventory();
  if (existing) {
    assertOwnedContainer(existing, current);
    if (options.outbound && Object.keys(options.outbound).length > 0) {
      throw new CliError("OUTBOUND_RESTART_REQUIRED", "outbound policy changed; run wx restart to recreate the container", EXIT.ARGUMENT);
    }
    if (!current) throw new CliError("INSTANCE_INVENTORY_MISSING", "existing container has no trusted inventory", EXIT.ENVIRONMENT);
    if (!existing.State?.Running) docker(["start", CONTAINER_NAME], { inherit: true });
    await waitCompatible(options.token);
    return current;
  }
  const selected = resolveImage({ explicit: options.image, pull: options.pull, noPull: options.noPull, localDefault: options.localDefault });
  const provisional = createInventory(selected.requestedReference, options.identity, selected.digest);
  saveInventory(provisional);
  ensureOwnedVolumes(provisional);
  const args = buildDockerRunArgs(options.identity, {
    image: selected.runReference,
    containerName: CONTAINER_NAME,
    tokenPath: TOKEN_PATH,
    port: DEFAULT_PORT,
    proxy: options.proxy,
    outbound: options.outbound,
  });
  args.splice(args.length - 1, 0, "--label", `${INSTANCE_LABEL}=default`, "--label", `${IMAGE_LABEL}=${selected.digest || selected.runReference}`);
  docker(args, { inherit: true });
  const created = inspectContainer();
  if (!created) throw new CliError("CONTAINER_INSPECT_FAILED", "created container cannot be inspected", EXIT.ENVIRONMENT);
  const inventory = { ...provisional, containerId: created.Id, updatedAt: new Date().toISOString() };
  saveInventory(inventory);
  try { await waitCompatible(options.token); } catch (error) {
    docker(["rm", "-f", created.Id], { inherit: true });
    saveInventory({ ...provisional, updatedAt: new Date().toISOString() });
    throw error;
  }
  return inventory;
}

export function outboundFromContainer(info: DockerInspect): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of info.Config?.Env ?? []) {
    const index = entry.indexOf("=");
    if (index > 0 && entry.startsWith("AGENT_WECHAT_OUTBOUND_") || entry.startsWith("AGENT_WECHAT_QUIET_") || entry.startsWith("AGENT_WECHAT_CHAT_COOLDOWN_MS")) result[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return result;
}

export function stopInstance(): { stopped: boolean } {
  if (!dockerAvailable()) throw new CliError("DOCKER_UNAVAILABLE", "Docker daemon is unavailable", EXIT.ENVIRONMENT);
  const info = inspectContainer();
  if (!info) return { stopped: false };
  const inventory = loadInventory();
  assertOwnedContainer(info, inventory);
  if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "refusing to remove an unowned container", EXIT.ENVIRONMENT);
  docker(["rm", "-f", info.Id], { inherit: true });
  return { stopped: true };
}

export function purgeInstance(): { removed: string[]; remaining: string[] } {
  const inventory = loadInventory();
  if (!inventory) throw new CliError("INSTANCE_INVENTORY_MISSING", "nothing can be purged without a trusted inventory", EXIT.CLEANUP);
  stopInstance();
  assertOwnedVolumes(inventory);
  const removed: string[] = [];
  const remaining: string[] = [];
  for (const volume of inventory.volumes) {
    try { docker(["volume", "rm", volume]); removed.push(`volume:${volume}`); } catch { remaining.push(`volume:${volume}`); }
  }
  for (const file of [TOKEN_PATH, path.join(CONFIG_DIR, "device-identity.env"), path.join(CONFIG_DIR, "device-identity.json")]) {
    try { assertSafePurgePath(file, CONFIG_DIR); } catch { remaining.push(path.basename(file)); continue; }
    try { fs.unlinkSync(file); removed.push(path.basename(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") remaining.push(path.basename(file)); }
  }
  if (remaining.length === 0) removeInventory();
  else throw new CliError("CLEANUP_INCOMPLETE", `remaining resources: ${remaining.join(", ")}`, EXIT.CLEANUP);
  return { removed, remaining };
}

export async function replaceImage(options: { image: string; identity: DeviceIdentity; token: string }): Promise<InstanceInventory> {
  const previous = loadInventory();
  if (!previous) throw new CliError("INSTANCE_INVENTORY_MISSING", "start the instance before image upgrade", EXIT.ENVIRONMENT);
  const info = inspectContainer();
  if (info) assertOwnedContainer(info, previous);
  const reconciled = previous;
  const selected = resolveImage({ explicit: options.image, pull: true, localDefault: previous.imageRef });
  if (selected.digest === reconciled.imageDigest) return reconciled;
  if (info) {
    if (info.State?.Running) docker(["stop", info.Id], { inherit: true });
    docker(["rename", info.Id, `${CONTAINER_NAME}-rollback`]);
  }
  try {
    const next = await startInstance({ identity: options.identity, token: options.token, image: selected.digest!, noPull: true, localDefault: previous.imageRef });
    if (info) docker(["rm", "-f", info.Id]);
    return next;
  } catch (error) {
    try {
      const failed = inspectContainer();
      if (failed) docker(["rm", "-f", failed.Id]);
      if (info) docker(["rename", info.Id, CONTAINER_NAME]);
      saveInventory(reconciled);
      if (info?.State?.Running) docker(["start", CONTAINER_NAME]);
    } catch {
      throw new CliError("ROLLBACK_FAILED", "image upgrade failed and rollback was incomplete", EXIT.ROLLBACK);
    }
    throw error;
  }
}
