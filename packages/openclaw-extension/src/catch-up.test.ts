import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@agent-wechat/shared";
import { isCatchUpBatch, selectCatchUpMessages } from "./catch-up.ts";

function message(localId: number, ageMs: number, nowMs: number): Message {
  return {
    localId,
    serverId: localId,
    chatId: "wxid_test",
    type: 1,
    content: String(localId),
    timestamp: new Date(nowMs - ageMs).toISOString(),
  };
}

test("isCatchUpBatch distinguishes a normal missed tick from a recovery backlog", () => {
  const nowMs = Date.parse("2026-08-13T06:00:00Z");
  assert.equal(isCatchUpBatch([
    message(1, 10_000, nowMs),
    message(2, 5_000, nowMs),
  ], { maxMessages: 10, maxAgeMs: 60_000, nowMs }), false);
  assert.equal(isCatchUpBatch([
    message(1, 120_000, nowMs),
  ], { maxMessages: 10, maxAgeMs: 60_000, nowMs }), true);
});

test("selectCatchUpMessages keeps only the bounded recent suffix", () => {
  const nowMs = Date.parse("2026-08-13T06:00:00Z");
  const result = selectCatchUpMessages([
    message(1, 600_000, nowMs),
    message(2, 40_000, nowMs),
    message(3, 30_000, nowMs),
    message(4, 20_000, nowMs),
  ], { maxMessages: 2, maxAgeMs: 60_000, nowMs });

  assert.deepEqual(result.messages.map((item) => item.localId), [3, 4]);
  assert.equal(result.cursor, 4);
  assert.equal(result.skipped, 2);
});

test("selectCatchUpMessages makes recovery read-only while advancing the cursor", () => {
  const nowMs = Date.parse("2026-08-13T06:00:00Z");
  const result = selectCatchUpMessages([
    message(4, 20_000, nowMs),
    message(5, 10_000, nowMs),
  ], { maxMessages: 10, maxAgeMs: 60_000, nowMs }, "read-only");

  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor, 5);
  assert.equal(result.skipped, 2);
});

test("selectCatchUpMessages advances the cursor when every message is stale", () => {
  const nowMs = Date.parse("2026-08-13T06:00:00Z");
  const result = selectCatchUpMessages([
    message(9, 600_000, nowMs),
    message(10, 500_000, nowMs),
  ], { maxMessages: 10, maxAgeMs: 60_000, nowMs });

  assert.deepEqual(result.messages, []);
  assert.equal(result.cursor, 10);
  assert.equal(result.skipped, 2);
});
