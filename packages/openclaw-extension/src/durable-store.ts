import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class DurableStoreError extends Error {
  readonly code = "DURABLE_STORE_IO_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableStoreError";
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write a complete JSON snapshot before replacing the visible state file. */
export function writeDurableJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    syncPath(temp);
    renameSync(temp, path);
    syncPath(dirname(path));
  } catch (error) {
    throw new DurableStoreError(`durable store write failed: ${path}`, { cause: error });
  }
}

export function readDurableJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new DurableStoreError(`durable store read failed: ${path}`, { cause: error });
  }
}

export function removeDurableJson(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
    syncPath(dirname(path));
  } catch (error) {
    throw new DurableStoreError(`durable store remove failed: ${path}`, { cause: error });
  }
}

/** Preserve the unreadable snapshot and create a durable blocker marker. */
export function quarantineDurableJson(path: string, blockerPath: string): string {
  const quarantinePath = `${path}.corrupt`;
  try {
    rmSync(quarantinePath, { force: true });
    renameSync(path, quarantinePath);
    writeFileSync(blockerPath, JSON.stringify({ version: 1, quarantine: quarantinePath }), { mode: 0o600 });
    syncPath(blockerPath);
    syncPath(dirname(path));
    return quarantinePath;
  } catch (error) {
    throw new DurableStoreError(`durable store quarantine failed: ${path}`, { cause: error });
  }
}
