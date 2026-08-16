import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import { equalCursorUnreadKey, selectCursorMessages } from "./monitor-cursor.ts";

function chat(overrides: Partial<Chat>): Chat {
  return {
    id: "wxid_first",
    username: "wxid_first",
    name: "First",
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  };
}

function message(localId: number): Message {
  return {
    localId,
    serverId: localId,
    chatId: "wxid_first",
    type: 1,
    content: `m${localId}`,
    timestamp: "2026-08-16T00:00:00.000Z",
  };
}

test("restored cursor equal to first unread localId is selected once", () => {
  const lastSeen = new Map([["wxid_first", 1]]);
  const equalCursorUnreadDispatched = new Set<string>();
  const unreadChat = chat({ unreadCount: 1, lastMsgLocalId: 1 });
  const messages = [message(1)];

  const first = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    lastSeen,
    equalCursorUnreadDispatched,
  );
  assert.equal(first.firstPoll, false);
  assert.deepEqual(first.messages.map((m) => m.localId), [1]);

  equalCursorUnreadDispatched.add(equalCursorUnreadKey("wxid_first", 1));
  const second = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    lastSeen,
    equalCursorUnreadDispatched,
  );
  assert.deepEqual(second.messages, []);
});

test("normal non-first polls only select ids above the cursor", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 2, lastMsgLocalId: 3 }),
    [message(1), message(2), message(3)],
    new Map([["wxid_first", 1]]),
    new Set(),
  );
  assert.deepEqual(result.messages.map((m) => m.localId), [2, 3]);
});

test("equal cursor recovery is limited to the reported unread suffix", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 2 }),
    [message(1)],
    new Map([["wxid_first", 1]]),
    new Set(),
  );
  assert.deepEqual(result.messages, []);
});

test("first poll still seeds read history before the unread suffix", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 3 }),
    [message(1), message(2), message(3)],
    new Map(),
    new Set(),
  );
  assert.equal(result.seedLastSeen, 2);
  assert.deepEqual(result.messages.map((m) => m.localId), [3]);
});
