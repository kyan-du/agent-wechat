import type { InstanceInventory } from "./instance-inventory.ts";

export const INSTANCE_LABEL = "dev.visionclaw.agent-wechat.instance";
export const IMAGE_LABEL = "dev.visionclaw.agent-wechat.image";
export const VOLUME_ROLE_LABEL = "dev.visionclaw.agent-wechat.volume-role";

export type OwnershipInspect = {
  Id: string;
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[]; Hostname?: string };
  HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }> | null> };
  Mounts?: Array<{ Name?: string; Destination?: string; Type?: string; Source?: string }>;
};

function exactEnv(env: string[] | undefined, key: string): string | undefined {
  const values = (env ?? []).filter((entry) => entry.startsWith(`${key}=`)).map((entry) => entry.slice(key.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

export function containerOwnershipError(
  info: OwnershipInspect,
  inventory: InstanceInventory,
  options: { ignoreContainerId?: boolean } = {},
): { code: string; message: string } | undefined {
  if (!options.ignoreContainerId && inventory.containerId && info.Id !== inventory.containerId) {
    return { code: "CONTAINER_ID_MISMATCH", message: "container identity changed" };
  }
  if (info.Config?.Labels?.[INSTANCE_LABEL] !== "default") {
    return { code: "CONTAINER_OWNERSHIP_MISMATCH", message: "container is not owned by this instance" };
  }
  const expectedImage = inventory.imageDigest ?? inventory.imageRef;
  if (info.Config?.Image !== expectedImage || info.Config?.Labels?.[IMAGE_LABEL] !== expectedImage) {
    return { code: "CONTAINER_IMAGE_MISMATCH", message: "container image does not match inventory" };
  }
  const env = info.Config?.Env;
  if (
    info.Config?.Hostname !== inventory.identity.hostname ||
    exactEnv(env, "AGENT_WECHAT_MACHINE_ID") !== inventory.identity.machineId ||
    exactEnv(env, "AGENT_WECHAT_HOSTNAME") !== inventory.identity.hostname ||
    exactEnv(env, "AGENT_WECHAT_MAC") !== inventory.identity.mac
  ) {
    return { code: "CONTAINER_IDENTITY_MISMATCH", message: "container identity does not match inventory" };
  }
  const mounts = new Map((info.Mounts ?? []).map((mount) => [mount.Destination, mount]));
  const data = mounts.get("/data");
  const home = mounts.get("/home/wechat");
  const token = mounts.get("/data/auth-token");
  if (
    data?.Type !== "volume" || data.Name !== inventory.volumes[0] ||
    home?.Type !== "volume" || home.Name !== inventory.volumes[1] ||
    token?.Type !== "bind" || token.Source !== inventory.tokenPath
  ) {
    return { code: "CONTAINER_RESOURCE_MISMATCH", message: "container mounts do not match inventory" };
  }
  const bindings = info.HostConfig?.PortBindings?.[`${inventory.port}/tcp`];
  if (!bindings || bindings.length !== 1 || bindings[0]?.HostPort !== String(inventory.port)) {
    return { code: "CONTAINER_PORT_MISMATCH", message: "container port does not match inventory" };
  }
  return undefined;
}

export type VolumeInspect = {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
};

export function volumeOwnershipError(
  info: VolumeInspect,
  expectedName: string,
  expectedRole: "data" | "wechat-home",
): { code: string; message: string } | undefined {
  if (
    info.Name !== expectedName ||
    info.Driver !== "local" ||
    info.Labels?.[INSTANCE_LABEL] !== "default" ||
    info.Labels?.[VOLUME_ROLE_LABEL] !== expectedRole
  ) {
    return { code: "VOLUME_OWNERSHIP_MISMATCH", message: `volume ${expectedName} is outside the trusted instance scope` };
  }
  return undefined;
}
