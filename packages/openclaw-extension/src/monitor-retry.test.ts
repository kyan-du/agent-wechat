import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import {
  commitResetDispatchPrefix,
  loadPendingResetRetries,
  MAX_PENDING_RESET_CHATS,
  MAX_PENDING_RESET_MESSAGES,
  PendingRetryStateError,
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
  commitResetDispatchPrefix(retry, "wxid_reset", message(40));
  mergePendingResetMessages(retry, "wxid_reset", chat(1, 101), [message(101)]);

  assert.equal(retry.lastSeenId.get("wxid_reset"), 40);
  assert.deepEqual(
    retry.pendingMessageScans.get("wxid_reset")?.messages.map((item) => item.localId),
    Array.from({ length: 61 }, (_, index) => index + 41),
  );

  commitResetDispatchPrefix(retry, "wxid_reset", message(101));
  assert.equal(retry.pendingMessageScans.has("wxid_reset"), false);
});

test("partial equal-ID generation commit preserves the failed identity across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-equal-"));
  const retry = state();
  const first = message(100, 1);
  const second = message(100, 2);
  queueResetGenerationRetry(retry, "wxid_reset", chat(2), [first, second], 0);
  retry.persist = () => persistPendingResetRetries("default", retry.pendingMessageScans, dir);

  commitResetDispatchPrefix(retry, "wxid_reset", first);
  const restored = loadPendingResetRetries("default", dir);
  assert.deepEqual(restored.get("wxid_reset")?.messages.map((item) => item.serverId), [20_100]);

  const afterRestart: MonitorRetryState = {
    pendingMessageScans: restored,
    lastSeenId: new Map([["wxid_reset", 100]]),
  };
  commitResetDispatchPrefix(afterRestart, "wxid_reset", second);
  assert.equal(afterRestart.pendingMessageScans.has("wxid_reset"), false);
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

test("corrupt retry persistence is quarantined and stops recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-corrupt-"));
  const path = join(dir, "wechat", "monitor-retry-default.json");
  mkdirSync(join(dir, "wechat"), { recursive: true });
  writeFileSync(path, "not-json");

  assert.throws(
    () => loadPendingResetRetries("default", dir),
    (error) => error instanceof PendingRetryStateError &&
      error.code === "RETRY_STATE_CORRUPT" &&
      error.message.includes(`${path}.corrupt`) &&
      error.message.includes(`${path}.blocked`) &&
      error.message.includes("explicitly remove"),
  );
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}.corrupt`), true);
  assert.equal(existsSync(`${path}.blocked`), true);
  assert.throws(
    () => loadPendingResetRetries("default", dir),
    (error) => error instanceof PendingRetryStateError && error.code === "RETRY_STATE_BLOCKED",
  );
  rmSync(`${path}.blocked`);
  assert.equal(loadPendingResetRetries("default", dir).size, 0);
});

test("operator restore plus blocker acknowledgement resumes retry loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-restore-"));
  const path = join(dir, "wechat", "monitor-retry-default.json");
  mkdirSync(join(dir, "wechat"), { recursive: true });
  writeFileSync(path, "truncated");
  assert.throws(() => loadPendingResetRetries("default", dir));

  const restoredRetry = state();
  queueResetGenerationRetry(restoredRetry, "wxid_reset", chat(1), [message(100)], 0);
  persistPendingResetRetries("restored", restoredRetry.pendingMessageScans, dir);
  const restoredPath = join(dir, "wechat", "monitor-retry-restored.json");
  renameSync(restoredPath, path);
  rmSync(`${path}.blocked`);

  assert.deepEqual(
    loadPendingResetRetries("default", dir).get("wxid_reset")?.messages.map((item) => item.localId),
    [100],
  );
});

test("persisted retry validation rejects malformed chat and message fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-retry-schema-"));
  const path = join(dir, "wechat", "monitor-retry-default.json");
  mkdirSync(join(dir, "wechat"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1,
    entries: [["wxid_reset", {
      chat: { ...chat(1), unreadCount: "1" },
      messages: [{ ...message(1), localId: "1" }],
      readyForDispatch: true,
    }]],
  }));
  assert.throws(
    () => loadPendingResetRetries("default", dir),
    (error) => error instanceof PendingRetryStateError && error.code === "RETRY_STATE_CORRUPT",
  );
  assert.equal(existsSync(`${path}.corrupt`), true);
});

test("101st pending chat is rejected without erasing existing retries", () => {
  const retry = state();
  for (let index = 0; index < MAX_PENDING_RESET_CHATS; index += 1) {
    const id = `wxid_${index}`;
    queueResetGenerationRetry(
      retry,
      id,
      { ...chat(1), id, username: id },
      [{ ...message(1), chatId: id }],
      index,
    );
  }

  assert.throws(
    () => queueResetGenerationRetry(
      retry,
      "wxid_overflow",
      { ...chat(1), id: "wxid_overflow", username: "wxid_overflow" },
      [{ ...message(1), chatId: "wxid_overflow" }],
    ),
    (error) => error instanceof PendingRetryStateError && error.code === "RETRY_CAPACITY",
  );
  assert.equal(retry.pendingMessageScans.size, MAX_PENDING_RESET_CHATS);
  assert.equal(retry.pendingMessageScans.has("wxid_0"), true);
});

test("10001st pending row is rejected without truncating the existing batch", () => {
  const retry = state();
  queueResetGenerationRetry(
    retry,
    "wxid_reset",
    chat(1, MAX_PENDING_RESET_MESSAGES),
    Array.from({ length: MAX_PENDING_RESET_MESSAGES }, (_, index) => message(index + 1)),
  );

  assert.throws(
    () => mergePendingResetMessages(
      retry,
      "wxid_reset",
      chat(1, MAX_PENDING_RESET_MESSAGES + 1),
      [message(MAX_PENDING_RESET_MESSAGES + 1)],
    ),
    (error) => error instanceof PendingRetryStateError && error.code === "RETRY_CAPACITY",
  );
  assert.equal(retry.pendingMessageScans.get("wxid_reset")?.messages.length, MAX_PENDING_RESET_MESSAGES);
});

test("equal-tail second reset identities merge instead of hiding behind numeric equality", () => {
  const retry = state();
  queueResetGenerationRetry(retry, "wxid_reset", chat(1), [message(100, 1)], 0);
  const merged = mergePendingResetMessages(retry, "wxid_reset", chat(1), [message(100, 2)]);
  assert.deepEqual(merged.map((item) => item.serverId), [10_100, 20_100]);
});
