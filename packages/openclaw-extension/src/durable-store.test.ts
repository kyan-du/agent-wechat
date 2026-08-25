import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStoreError, quarantineDurableJson, readDurableJson, removeDurableJson, writeDurableJson } from "./durable-store.ts";

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

test("remove is idempotent for an absent state", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-durable-store-"));
  assert.doesNotThrow(() => removeDurableJson(join(dir, "missing.json")));
});
