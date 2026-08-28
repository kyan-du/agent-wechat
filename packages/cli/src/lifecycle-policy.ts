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

export function isUsableLocalVolume(existing: VolumeInspect): boolean {
  return existing.Driver === "local";
}
