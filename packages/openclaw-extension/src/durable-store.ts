import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const MAX_DURABLE_JSON_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export class DurableStoreError extends Error {
  readonly code = "DURABLE_STORE_IO_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableStoreError";
  }
}

function assertTrustedPath(path: string, root?: string): void {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new DurableStoreError("durable store paths must be absolute and contain no null bytes");
  }
  if (root) {
    if (!isAbsolute(root) || path !== root && !path.startsWith(`${root}/`)) {
      throw new DurableStoreError("durable store path is outside the approved state root");
    }
    for (const part of path.slice(root.length).split("/")) {
      if (!part) continue;
      const candidate = path.slice(0, path.indexOf(part) + part.length);
      try {
        if (statSync(candidate).isSymbolicLink()) throw new DurableStoreError("durable store path contains a symlink");
      } catch (error) {
        if (error instanceof DurableStoreError) throw error;
      }
    }
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

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function lockPath(path: string): string { return `${path}.lock`; }

function acquireLock(path: string): string {
  assertTrustedPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = lockPath(path);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
      syncPath(lock);
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new DurableStoreError(`durable store lock failed: ${path}`, { cause: error });
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // A concurrent owner may be replacing/removing the lock; retry.
      }
      sleepSync(10);
    }
  }
  throw new DurableStoreError(`durable store lock timeout: ${path}`);
}

function releaseLock(lock: string): void {
  try { rmSync(lock, { force: true }); } catch { /* the owner may have been reaped */ }
}

export function withDurableJsonLock<T>(path: string, operation: () => T): T {
  const lock = acquireLock(path);
  try { return operation(); } finally { releaseLock(lock); }
}

function serialize(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_DURABLE_JSON_BYTES) {
    throw new DurableStoreError(`durable store value exceeds ${MAX_DURABLE_JSON_BYTES} bytes`);
  }
  return json;
}

export function writeDurableJsonLocked(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, serialize(value), { mode: 0o600 });
    syncPath(temp);
    renameSync(temp, path);
    syncPath(dirname(path));
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/** Write a complete JSON snapshot while the caller owns the path lock. */
function writeUnlocked(path: string, value: unknown): void { writeDurableJsonLocked(path, value); }

/** Write a complete JSON snapshot before replacing the visible state file. */
export function writeDurableJson(path: string, value: unknown, root?: string): void {
  assertTrustedPath(path, root);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    withDurableJsonLock(path, () => writeUnlocked(path, value));
  } catch (error) {
    if (error instanceof DurableStoreError) throw error;
    throw new DurableStoreError(`durable store write failed: ${path}`, { cause: error });
  }
}

/** Atomically read, transform, and replace one snapshot under the path lock. */
export function updateDurableJson<T>(path: string, update: (current: T | undefined) => T, root?: string): T {
  assertTrustedPath(path, root);
  try {
    return withDurableJsonLock(path, () => {
      const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
      const next = update(current);
      writeUnlocked(path, next);
      return next;
    });
  } catch (error) {
    if (error instanceof DurableStoreError) throw error;
    throw new DurableStoreError(`durable store update failed: ${path}`, { cause: error });
  }
}

export function readDurableJson<T>(path: string): T | undefined {
  assertTrustedPath(path);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new DurableStoreError(`durable store read failed: ${path}`, { cause: error });
  }
}

export function removeDurableJson(path: string): void {
  assertTrustedPath(path);
  if (!existsSync(path)) return;
  try {
    withDurableJsonLock(path, () => {
      rmSync(path, { force: true });
      syncPath(dirname(path));
    });
  } catch (error) {
    throw new DurableStoreError(`durable store remove failed: ${path}`, { cause: error });
  }
}

/** Publish a recoverable marker before moving unreadable state. */
export function quarantineDurableJson(path: string, blockerPath: string): string {
  assertTrustedPath(path);
  assertTrustedPath(blockerPath);
  const quarantinePath = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
  const markerPath = `${path}.quarantine`;
  try {
    withDurableJsonLock(path, () => {
      writeDurableJsonLocked(markerPath, { version: 1, quarantine: quarantinePath, blocker: blockerPath });
      renameSync(path, quarantinePath);
      syncPath(dirname(path));
      writeDurableJsonLocked(blockerPath, { version: 1, quarantine: quarantinePath });
      rmSync(markerPath, { force: true });
      syncPath(dirname(path));
    });
    return quarantinePath;
  } catch (error) {
    throw new DurableStoreError(`durable store quarantine failed: ${path}`, { cause: error });
  }
}

export function recoverDurableQuarantine(path: string): void {
  const markerPath = `${path}.quarantine`;
  if (!existsSync(markerPath)) return;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { quarantine?: string; blocker?: string };
    if (typeof marker.quarantine !== "string" || typeof marker.blocker !== "string") throw new Error("invalid quarantine marker");
    withDurableJsonLock(path, () => {
      if (existsSync(path)) renameSync(path, marker.quarantine!);
      writeDurableJsonLocked(marker.blocker!, { version: 1, quarantine: marker.quarantine });
      rmSync(markerPath, { force: true });
      syncPath(dirname(path));
    });
  } catch (error) {
    throw new DurableStoreError(`durable store quarantine recovery failed: ${path}`, { cause: error });
  }
}
