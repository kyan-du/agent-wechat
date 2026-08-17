import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import {
  commitResetDispatchPrefix,
  loadPendingResetRetries,
  MAX_PENDING_RESET_CHATS,
  mergePendingResetMessages,
  monitorChatsToProcess,
  persistPendingResetRetries,
  queueResetGenerationRetry,
  recordResetRetryFailure,
  type MonitorRetryState,
} from "./monitor-retry.ts";

function chat(unreadCount: number, lastMsgLocalId = 100): Chat {
  return {
    id: "wxid_reset",
    username: "wxid_reset",
    name: "Reset",
    unreadCount,
    isGroup: false,
    lastMsgLocalId,
  };
}

function message(localId: number, generation = 1): Message {
  return {
    localId,
    serverId: generation * 10_000 + localId,
    chatId: "wxid_reset",
    type: 1,
    content: `reset-${generation}-${localId}`,
    timestamp: "2026-08-17T00:00:00.000Z",
  };
}

function state(): MonitorRetryState {
  return {
    pendingMessageScans: new Map(),
    lastSeenId: new Map([["wxid_reset", 100]]),
  };
}

test("first reset dispatch failure remains scheduler-reachable after open clears unread", () => {
  const retry = state();
  queueResetGenerationRetry(
    retry,
    "wxid_reset",
    chat(1),
    Array.from({ length: 100 }, (_, index) => message(index + 1)),
    0,
  );
  commitResetDispatchPrefix(retry, "wxid_reset", undefined);
  const next = monitorChatsToProcess([chat(0)], retry, 0);

  assert.equal(retry.lastSeenId.get("wxid_reset"), 100);
  assert.equal(next.has("wxid_reset"), true);
  assert.equal(retry.pendingMessageScans.get("wxid_reset")?.messages.length, 100);
});

test("current chat metadata wins and new arrivals merge into a failed reset batch", () => {
  const retry = state();
  queueResetGenerationRetry(
    retry,
    "wxid_reset",
    chat(1),
    Array.from({ length: 100 }, (_, index) => message(index + 1)),
    0,
  );
  const current = chat(1, 101);
  const scheduled = monitorChatsToProcess([current], retry, 0).get("wxid_reset");
  assert.equal(scheduled?.lastMsgLocalId, 101);

  const merged = mergePendingResetMessages(retry, "wxid_reset", current, [message(100), message(101)]);
  assert.deepEqual(merged.map((item) => item.localId), Array.from({ length: 101 }, (_, i) => i + 1));
});

test("mid-reset dispatch failure atomically commits prefix and merges later traffic", () => {
  const retry = state();
  queueResetGenerationRetry(
    retry,
    "wxid_reset",
    chat(1),
    Array.from({ length: 100 }, (_, index) => message(index + 1)),
    0,
  );
  commitResetDispatchPrefix(retry, "wxid_reset", 40);
  mergePendingResetMessages(retry, "wxid_reset", chat(1, 101), [message(101)]);

  assert.equal(retry.lastSeenId.get("wxid_reset"), 40);
  assert.deepEqual(
    retry.pendingMessageScans.get("wxid_reset")?.messages.map((item) => item.localId),
    Array.from({ length: 61 }, (_, index) => index + 41),
  );

  commitResetDispatchPrefix(retry, "wxid_reset", 101);
  assert.equal(retry.pendingMessageScans.has("wxid_reset"), false);
});

test("a second reset generation remains distinct while the first is pending", () => {
  const retry = state();
  queueResetGenerationRetry(retry, "wxid_reset", chat(1), [message(99), message(100)], 0);
  const second = [message(1, 2), message(2, 2)];
  const merged = mergePendingResetMessages(retry, "wxid_reset", chat(2, 2), second);

  assert.deepEqual(merged.map((item) => [item.localId, item.serverId]), [
    [1, 20_001],
    [2, 20_002],
    [99, 10_099],
    [100, 10_100],
  ]);
});

test("permanent failure backs off instead of hot-looping", () => {
  const retry = state();
  queueResetGenerationRetry(retry, "wxid_reset", chat(1), [message(100)], 0);
  recordResetRetryFailure(retry, "wxid_reset", 0);

  assert.equal(monitorChatsToProcess([], retry, 999).has("wxid_reset"), false);
  assert.equal(monitorChatsToProcess([], retry, 1_000).has("wxid_reset"), true);
});

test("pending reset retry survives process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-"));
  const retry = state();
  queueResetGenerationRetry(retry, "wxid_reset", chat(1), [message(100)], 0);
  persistPendingResetRetries("default", retry.pendingMessageScans, dir);

  const restored = loadPendingResetRetries("default", dir);
  assert.equal(restored.get("wxid_reset")?.readyForDispatch, true);
  assert.deepEqual(restored.get("wxid_reset")?.messages.map((item) => item.localId), [100]);
});

test("corrupt retry persistence fails closed to an empty store", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-corrupt-"));
  const path = join(dir, "wechat", "monitor-retry-default.json");
  mkdirSync(join(dir, "wechat"), { recursive: true });
  writeFileSync(path, "not-json");
  assert.equal(loadPendingResetRetries("default", dir).size, 0);
});

test("pending reset retries are bounded by chat cardinality", () => {
  const retry = state();
  for (let index = 0; index <= MAX_PENDING_RESET_CHATS; index += 1) {
    const id = `wxid_${index}`;
    queueResetGenerationRetry(
      retry,
      id,
      { ...chat(1), id, username: id },
      [{ ...message(1), chatId: id }],
      index,
    );
  }

  assert.equal(retry.pendingMessageScans.size, MAX_PENDING_RESET_CHATS);
  assert.equal(retry.pendingMessageScans.has("wxid_0"), false);
});
