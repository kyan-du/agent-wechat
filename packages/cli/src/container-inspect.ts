import type { DeviceIdentity } from "./device-identity.ts";

export function endpointMacs(info: {
  NetworkSettings?: {
    MacAddress?: string;
    Networks?: Record<string, { MacAddress?: string } | undefined>;
  };
}): string[] {
  const macs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) macs.add(value.toLowerCase());
  };
  add(info.NetworkSettings?.MacAddress);
  for (const network of Object.values(info.NetworkSettings?.Networks ?? {})) {
    add(network?.MacAddress);
  }
  return [...macs];
}

export function configuredMacs(info: {
  HostConfig?: { MacAddress?: string };
  Config?: { MacAddress?: string };
  NetworkSettings?: {
    Networks?: Record<string, { MacAddress?: string } | undefined>;
  };
}): string[] {
  const macs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) macs.add(value.toLowerCase());
  };
  add(info.HostConfig?.MacAddress);
  add(info.Config?.MacAddress);
  for (const network of Object.values(info.NetworkSettings?.Networks ?? {})) {
    add(network?.MacAddress);
  }
  return [...macs];
}

export function uniqueInspectEnv(env: unknown, key: string): string {
  if (!Array.isArray(env)) throw new Error("unexpected inspect env shape");
  const values = env
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith(`${key}=`))
    .map((entry) => entry.slice(key.length + 1));
  if (values.length === 0) throw new Error(`missing ${key}`);
  if (values.length > 1) throw new Error(`duplicate ${key}`);
  return values[0];
}

export function containerInspectMatchesIdentity(raw: string, identity: DeviceIdentity): boolean {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("unexpected inspect shape");
  }
  const info = parsed[0] as {
    HostConfig?: { MacAddress?: string };
    Config?: { Hostname?: string; Env?: string[]; MacAddress?: string };
    NetworkSettings?: {
      MacAddress?: string;
      Networks?: Record<string, { MacAddress?: string } | undefined>;
    };
  };
  const env = info.Config?.Env ?? [];
  const machineId = uniqueInspectEnv(env, "AGENT_WECHAT_MACHINE_ID");
  const envHost = uniqueInspectEnv(env, "AGENT_WECHAT_HOSTNAME");
  const envMac = uniqueInspectEnv(env, "AGENT_WECHAT_MAC");
  const hostname = info.Config?.Hostname;
  const liveMacs = endpointMacs(info);
  const durableMacs = configuredMacs(info);
  if (liveMacs.some((mac) => mac !== identity.mac)) return false;
  if (durableMacs.some((mac) => mac !== identity.mac)) return false;
  return (
    hostname === identity.hostname &&
    machineId === identity.machineId &&
    envHost === identity.hostname &&
    envMac === identity.mac
  );
}

const DOCKER_ID_RE = /^[0-9a-f]{12,64}$/;

export function parseExactlyOneDockerId(output: string): string {
  const ids = output.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("empty docker id list");
  if (ids.length > 1) throw new Error("ambiguous docker id list");
  const id = ids[0].toLowerCase();
  if (!DOCKER_ID_RE.test(id)) throw new Error("invalid docker id");
  return id;
}

export function inspectContainerId(raw: string): string {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("unexpected inspect shape");
  }
  const id = (parsed[0] as { Id?: unknown }).Id;
  if (typeof id !== "string") throw new Error("missing inspect id");
  const normalized = id.toLowerCase();
  if (!DOCKER_ID_RE.test(normalized)) throw new Error("invalid inspect id");
  return normalized;
}

export function dockerIdsEqual(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export type ExistingContainerDecision =
  | { action: "use-existing"; id: string; start: boolean }
  | {
      action: "fail";
      reason: "ambiguous-id" | "inspect-failed" | "identity-mismatch" | "id-mismatch";
    };

/** Bind ps -aq, inspect, and ps -q to one container. Inspect errors are never "absent". */
export function bindExistingContainer(input: {
  psAllRaw: string;
  psRunningRaw: string;
  inspectOk: boolean;
  inspectRaw?: string;
  identity: DeviceIdentity;
}): ExistingContainerDecision {
  let boundId: string;
  try {
    boundId = parseExactlyOneDockerId(input.psAllRaw);
  } catch {
    return { action: "fail", reason: "ambiguous-id" };
  }
  if (!input.inspectOk || input.inspectRaw === undefined) {
    return { action: "fail", reason: "inspect-failed" };
  }
  let inspectId: string;
  try {
    inspectId = inspectContainerId(input.inspectRaw);
    if (!dockerIdsEqual(boundId, inspectId)) {
      return { action: "fail", reason: "id-mismatch" };
    }
    if (!containerInspectMatchesIdentity(input.inspectRaw, input.identity)) {
      return { action: "fail", reason: "identity-mismatch" };
    }
  } catch {
    return { action: "fail", reason: "identity-mismatch" };
  }
  const runningRaw = input.psRunningRaw.trim();
  if (runningRaw) {
    try {
      const runningId = parseExactlyOneDockerId(runningRaw);
      if (!dockerIdsEqual(boundId, runningId)) {
        return { action: "fail", reason: "id-mismatch" };
      }
    } catch {
      return { action: "fail", reason: "ambiguous-id" };
    }
    return { action: "use-existing", id: inspectId, start: false };
  }
  return { action: "use-existing", id: inspectId, start: true };
}
