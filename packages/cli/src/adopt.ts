import type { InstanceInventory } from "./instance-inventory.js";
import { hasOwnedVolume, type VolumeInspect } from "./lifecycle-policy.js";

/** Same instance when the fixed name is ours and both volumes still belong to it. */
export function sameFixedInstance(evidence: {
  containerName: string;
  volumes: [VolumeInspect | undefined, VolumeInspect | undefined];
  inventory: Pick<InstanceInventory, "containerName" | "volumes">;
}): boolean {
  if (evidence.containerName !== evidence.inventory.containerName) return false;
  const roles = ["data", "wechat-home"] as const;
  return roles.every((role, index) => {
    const volume = evidence.volumes[index];
    return Boolean(volume && hasOwnedVolume(volume, evidence.inventory.volumes[index], role));
  });
}
