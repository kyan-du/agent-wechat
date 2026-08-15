import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DeviceIdentity } from "./device-identity.js";
import { parseDeviceIdentity } from "./device-identity.js";
import { validatePublishedImageReference } from "./image-reference.js";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-wechat");
export const TOKEN_PATH = path.join(CONFIG_DIR, "token");
export const INSTANCE_PATH = path.join(CONFIG_DIR, "instance.json");
export const CONTAINER_NAME = "agent-wechat";
export const DEFAULT_PORT = 6174;
export const GHCR_IMAGE = "ghcr.io/kyan-du/agent-wechat";

export type InstanceInventory = {
  schemaVersion: 1;
  containerName: string;
  containerId?: string;
  imageRef: string;
  imageDigest?: string;
  port: number;
  volumes: string[];
  tokenPath: string;
  identityDir: string;
  identity: DeviceIdentity;
  createdAt: string;
  updatedAt: string;
};

function regularOrAbsent(target: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch { return; }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`UNSAFE_PATH:${target}`);
  }
}

export function secureRegularFile(target: string): void {
  regularOrAbsent(path.dirname(target));
  regularOrAbsent(target);
  const stat = fs.statSync(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`UNSAFE_FILE_PERMISSIONS:${target}`);
}

export function loadInventory(): InstanceInventory | undefined {
  try {
    regularOrAbsent(CONFIG_DIR);
    regularOrAbsent(INSTANCE_PATH);
    const value = JSON.parse(fs.readFileSync(INSTANCE_PATH, "utf8")) as InstanceInventory;
    const expectedVolumes = [`${CONTAINER_NAME}-data`, `${CONTAINER_NAME}-wechat-home`];
    const validImage = value.imageRef.startsWith("agent-wechat:")
      ? /^agent-wechat:(?:amd64|arm64)$/.test(value.imageRef)
      : (() => { try { validatePublishedImageReference(value.imageRef); return true; } catch { return false; } })();
    if (
      value.schemaVersion !== 1 ||
      value.containerName !== CONTAINER_NAME ||
      (value.containerId !== undefined && !/^[a-f0-9]{64}$/.test(value.containerId)) ||
      value.port !== DEFAULT_PORT ||
      !Array.isArray(value.volumes) ||
      value.volumes.length !== 2 ||
      value.volumes.some((volume, index) => volume !== expectedVolumes[index]) ||
      value.tokenPath !== TOKEN_PATH ||
      value.identityDir !== CONFIG_DIR ||
      !parseDeviceIdentity(value.identity) ||
      !validImage ||
      (value.imageDigest !== undefined && !new RegExp(`^${GHCR_IMAGE.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`).test(value.imageDigest))
    ) {
      throw new Error("INVALID_INSTANCE_INVENTORY");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "ENOENT") return undefined;
    if (!fs.existsSync(INSTANCE_PATH)) return undefined;
    throw error;
  }
}

export function saveInventory(value: InstanceInventory): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  regularOrAbsent(CONFIG_DIR);
  regularOrAbsent(INSTANCE_PATH);
  const temp = `${INSTANCE_PATH}.${process.pid}.tmp`;
  regularOrAbsent(temp);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, INSTANCE_PATH);
}

export function removeInventory(): void {
  regularOrAbsent(INSTANCE_PATH);
  try { fs.unlinkSync(INSTANCE_PATH); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function updateInventory(patch: Partial<InstanceInventory>): InstanceInventory {
  const current = loadInventory();
  if (!current) throw new Error("INSTANCE_INVENTORY_MISSING");
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  saveInventory(next);
  return next;
}

export function createInventory(imageRef: string, identity: DeviceIdentity, imageDigest?: string, containerId?: string): InstanceInventory {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    containerName: CONTAINER_NAME,
    containerId,
    imageRef,
    imageDigest,
    port: DEFAULT_PORT,
    volumes: [`${CONTAINER_NAME}-data`, `${CONTAINER_NAME}-wechat-home`],
    tokenPath: TOKEN_PATH,
    identityDir: CONFIG_DIR,
    identity,
    createdAt: now,
    updatedAt: now,
  };
}

export function assertSafePurgePath(target: string, root: string): void {
  regularOrAbsent(root);
  regularOrAbsent(target);
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`PURGE_CONTAINMENT_FAILED:${target}`);
  }
}
