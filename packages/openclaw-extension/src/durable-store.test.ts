import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStoreError, MAX_DURABLE_JSON_BYTES, quarantineDurableJson, readDurableJson, removeDurableJson, updateDurableJson, writeDurableJson } from "./durable-store.ts";

test("durable JSON writes are readable after atomic replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  const path = join(dir, "nested", "state.json");
  writeDurableJson(path, { version: 1, entries: ["a"] });
  assert.deepEqual(readDurableJson(path), { version: 1, entries: ["a"] });
  writeDurableJson(path, { version: 1, entries: ["b"] });
  assert.deepEqual(readDurableJson(path), { version: 1, entries: ["b"] });
});

test("malformed state is reported without being silently reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "not-json");
  assert.throws(() => readDurableJson(path), (error: unknown) => error instanceof DurableStoreError);
  assert.equal(existsSync(path), true);
});

test("quarantine preserves corrupt state and writes a blocker", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  const path = join(dir, "state.json");
  const blocker = `${path}.blocked`;
  writeFileSync(path, "not-json");
  const quarantine = quarantineDurableJson(path, blocker);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(quarantine), true);
  assert.deepEqual(readDurableJson(blocker), { version: 1, quarantine });
});

test("locked updates serialize concurrent read-modify-write operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  const path = join(dir, "state.json");
  writeDurableJson(path, { entries: [] as number[] });
  await Promise.all(Array.from({ length: 8 }, (_, value) => new Promise<void>((resolve) => {
    setTimeout(() => {
      updateDurableJson<{ entries: number[] }>(path, (current) => ({ entries: [...(current?.entries ?? []), value] }));
      resolve();
    }, value % 3);
  })));
  assert.deepEqual(readDurableJson<{ entries: number[] }>(path)?.entries.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("serialized size is bounded and failed writes clean temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  const path = join(dir, "state.json");
  assert.throws(() => writeDurableJson(path, "x".repeat(MAX_DURABLE_JSON_BYTES + 1)), /exceeds/);
  assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("remove is idempotent for an absent state", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  assert.doesNotThrow(() => removeDurableJson(join(dir, "missing.json")));
});
