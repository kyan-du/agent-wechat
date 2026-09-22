import type { InstanceInventory } from "./instance-inventory.ts";

export const INSTANCE_LABEL = "dev.visionclaw.agent-wechat.instance";
export const IMAGE_LABEL = "dev.visionclaw.agent-wechat.image";
export const VOLUME_ROLE_LABEL = "dev.visionclaw.agent-wechat.volume-role";

export type VolumeInspect = {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
};

export function hasOwnedContainer(info: { Config?: { Labels?: Record<string, string> } }): boolean {
  return info.Config?.Labels?.[INSTANCE_LABEL] === "default";
}

/** A legacy fixed-name container is safe to reconcile only when inventory binds its ID. */
export function isReconcileableContainer(
  info: { Id: string; Config?: { Labels?: Record<string, string> } },
  inventory?: Pick<InstanceInventory, "containerId">,
): boolean {
  if (hasOwnedContainer(info)) return true;
  const id = inventory?.containerId;
  return Boolean(id && (info.Id === id || info.Id.startsWith(id) || id.startsWith(info.Id)));
}

/** Read-only: a live container whose id drifted is stale, not an error and not trusted. */
export function inventoryBinding(
  live: { Id: string; Config?: { Labels?: Record<string, string> } } | undefined,
  inventory?: Pick<InstanceInventory, "containerId">,
): "trusted" | "stale" | "absent" {
  if (!inventory) return "absent";
  if (live && !isReconcileableContainer(live, inventory)) return "stale";
  return "trusted";
}

export function hasOwnedVolume(existing: VolumeInspect, name: string, role: "data" | "wechat-home"): boolean {
  return existing.Name === name && existing.Driver === "local" && existing.Labels?.[INSTANCE_LABEL] === "default" && existing.Labels?.[VOLUME_ROLE_LABEL] === role;
}

export type LiveMount = { Name?: string; Destination?: string; Type?: string };

const DESTINATIONS = ["/data", "/home/wechat"] as const;

/** Same instance only when the live container mounts both owned volumes at the instance paths. */
export function sameFixedInstance(evidence: {
  containerName: string;
  volumes: [VolumeInspect | undefined, VolumeInspect | undefined];
  mounts: LiveMount[] | undefined;
  inventory: Pick<InstanceInventory, "containerName" | "volumes">;
}): boolean {
  if (evidence.containerName !== evidence.inventory.containerName) return false;
  const roles = ["data", "wechat-home"] as const;
  return roles.every((role, index) => {
    const volume = evidence.volumes[index];
    const name = evidence.inventory.volumes[index];
    if (!volume || !hasOwnedVolume(volume, name, role)) return false;
    const mounted = (evidence.mounts ?? []).filter((mount) => mount.Destination === DESTINATIONS[index]);
    return mounted.length === 1 && mounted[0].Type === "volume" && mounted[0].Name === name;
  });
}
