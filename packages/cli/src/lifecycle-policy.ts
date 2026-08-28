import type { InstanceInventory } from "./instance-inventory.ts";

export const INSTANCE_LABEL = "dev.visionclaw.agent-wechat.instance";
export const IMAGE_LABEL = "dev.visionclaw.agent-wechat.image";
export const VOLUME_ROLE_LABEL = "dev.visionclaw.agent-wechat.volume-role";

export type VolumeInspect = {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
};

