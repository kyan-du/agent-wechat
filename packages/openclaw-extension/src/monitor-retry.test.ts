import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import {
  commitResetDispatchPrefix,
  monitorChatsToProcess,
  queueResetGenerationRetry,
  type MonitorRetryState,
} from "./monitor-retry.ts";

function chat(unreadCount: number): Chat {
  return {
    id: "wxid_reset",
    username: "wxid_reset",
    name: "Reset",
    unreadCount,
    isGroup: false,
    lastMsgLocalId: 100,
  };
}

function message(localId: number): Message {
  return {
    localId,
    serverId: 10_000 + localId,
    chatId: "wxid_reset",
    type: 1,
    content: `reset-${localId}`,
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
  );

  // First segment failed: no prefix commit and the old cursor remains authoritative.
  commitResetDispatchPrefix(retry, "wxid_reset", undefined);
  const next = monitorChatsToProcess([chat(0)], retry);

  assert.equal(retry.lastSeenId.get("wxid_reset"), 100);
  assert.equal(next.has("wxid_reset"), true);
  assert.equal(retry.pendingMessageScans.get("wxid_reset")?.messages.length, 100);
});

test("mid-reset dispatch failure atomically commits prefix and retries the suffix", () => {
  const retry = state();
  queueResetGenerationRetry(
    retry,
    "wxid_reset",
    chat(1),
    Array.from({ length: 100 }, (_, index) => message(index + 1)),
  );

  commitResetDispatchPrefix(retry, "wxid_reset", 40);
  const next = monitorChatsToProcess([chat(0)], retry);

  assert.equal(retry.lastSeenId.get("wxid_reset"), 40);
  assert.equal(next.has("wxid_reset"), true);
  assert.deepEqual(
    retry.pendingMessageScans.get("wxid_reset")?.messages.map((item) => item.localId),
    Array.from({ length: 60 }, (_, index) => index + 41),
  );

  commitResetDispatchPrefix(retry, "wxid_reset", 100);
  assert.equal(retry.pendingMessageScans.has("wxid_reset"), false);
  assert.equal(retry.lastSeenId.get("wxid_reset"), 100);
});
