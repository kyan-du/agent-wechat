import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaPipeline } from "./media-pipeline.ts";
import { validateInboundMedia } from "./inbound-media.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQqTjxH4QZYAwATZwJTT1ZqfsAAAAASUVORK5CYII=", "base64");
const image = (bytes = png) => ({ type: "image" as const, data: bytes.toString("base64"), format: "png", filename: "../photo.png" });

function saver(root: string, calls: string[]) {
  return async (buffer: Buffer, mime: string, filename: string) => {
    calls.push(`${mime}:${filename}:${buffer.length}`);
    return { path: join(root, `${calls.length}-${filename}`) };
  };
}

test("pipeline validates, hashes, saves, previews, and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-media-pipeline-"));
  const calls: string[] = [];
  const pipeline = new MediaPipeline("default", dir);
  const result = await pipeline.process(image(), { eventId: "a".repeat(64), chatId: "chat", localId: 1 }, saver(dir, calls), saver(dir, calls), 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.hash.length, 64);
  assert.equal(result.record.status, "processed");
  assert.deepEqual(result.record.stages, ["validated", "deduplicated", "original_saved", "preview_generated", "extraction_skipped"]);
  assert.equal(calls.length, 2);
  const restored = new MediaPipeline("default", dir).get(result.hash);
  assert.equal(restored?.previewPath, result.previewPath);
});

test("duplicate content reuses the durable original and preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-media-pipeline-"));
  const firstCalls: string[] = [];
  const pipeline = new MediaPipeline("default", dir);
  const first = await pipeline.process(image(), { eventId: "b".repeat(64), chatId: "chat", localId: 1 }, saver(dir, firstCalls), saver(dir, firstCalls));
  assert.equal(first.ok, true);
  const secondCalls: string[] = [];
  const second = await pipeline.process({ ...image(), filename: "renamed.png" }, { eventId: "c".repeat(64), chatId: "chat", localId: 2 }, saver(dir, secondCalls), saver(dir, secondCalls));
  assert.equal(second.ok, true);
  assert.equal(secondCalls.length, 0);
  if (first.ok && second.ok) assert.equal(second.originalPath, first.originalPath);
});

test("cleanup removes expired records and both stored paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-media-pipeline-"));
  const pipeline = new MediaPipeline("default", dir);
  const result = await pipeline.process(image(), { eventId: "e".repeat(64), chatId: "chat", localId: 1 }, saver(dir, []), saver(dir, []), 10);
  assert.equal(result.ok, true);
  const removed: string[] = [];
  assert.equal(await pipeline.cleanup({ olderThanMs: 1, now: 20, remove: async (path) => { removed.push(path); } }), 1);
  assert.equal(removed.length, 2);
  if (result.ok) assert.equal(pipeline.get(result.hash), undefined);
});

test("preview failure is durable and does not expose an untracked success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-media-pipeline-"));
  const pipeline = new MediaPipeline("default", dir);
  const result = await pipeline.process(image(), { eventId: "d".repeat(64), chatId: "chat", localId: 1 }, saver(dir, []), async () => { throw new Error("preview unavailable"); });
  assert.deepEqual(result, { ok: false, code: "MEDIA_PREVIEW_FAILED" });
  const hash = (await validateInboundMedia(image()));
  assert.equal(hash.ok, true);
});
