import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import { markCursorMessagesHandled, selectCursorMessages } from "./monitor-cursor.ts";

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

function advanceToHandledMessages(
  chatId: string,
  lastSeen: Map<string, number>,
  equalCursorUnreadHandled: Map<string, number>,
  messages: Message[],
): void {
  const cursor = markCursorMessagesHandled(chatId, messages, equalCursorUnreadHandled);
  if (cursor !== undefined) {
    lastSeen.set(chatId, cursor);
  }
}

test("restored cursor equal to first unread localId recovers exactly once", () => {
  const lastSeen = new Map([["wxid_first", 1]]);
  const equalCursorUnreadHandled = new Map<string, number>();
  const unreadChat = chat({ unreadCount: 1, lastMsgLocalId: 1 });
  const messages = [message(1)];

  const first = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.equal(first.firstPoll, false);
  assert.deepEqual(first.messages.map((m) => m.localId), [1]);

  advanceToHandledMessages("wxid_first", lastSeen, equalCursorUnreadHandled, first.messages);
  const second = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(second.messages, []);
});

test("normal first dispatch followed by stale unread snapshot does not redispatch", () => {
  const lastSeen = new Map<string, number>();
  const equalCursorUnreadHandled = new Map<string, number>();

  const first = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 10 }),
    [message(10)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.equal(first.firstPoll, true);
  assert.deepEqual(first.messages.map((m) => m.localId), [10]);

  advanceToHandledMessages("wxid_first", lastSeen, equalCursorUnreadHandled, first.messages);
  const stale = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 10 }),
    [message(10)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(stale.messages, []);
});

test("catch-up cursor advancement blocks later stale equal-cursor unread", () => {
  const lastSeen = new Map([["wxid_first", 3]]);
  const equalCursorUnreadHandled = new Map<string, number>();

  const catchup = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 0, lastMsgLocalId: 5 }),
    [message(4), message(5)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(catchup.messages.map((m) => m.localId), [4, 5]);

  advanceToHandledMessages("wxid_first", lastSeen, equalCursorUnreadHandled, catchup.messages);
  const stale = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 5 }),
    [message(5)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(stale.messages, []);
});

test("restart keeps restored equal-cursor recovery available once", () => {
  const restoredLastSeen = new Map([["wxid_first", 7]]);
  const restartedEqualCursorUnreadHandled = new Map<string, number>();
  const unreadChat = chat({ unreadCount: 1, lastMsgLocalId: 7 });
  const messages = [message(7)];

  const recovered = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    restoredLastSeen,
    restartedEqualCursorUnreadHandled,
  );
  assert.deepEqual(recovered.messages.map((m) => m.localId), [7]);

  advanceToHandledMessages(
    "wxid_first",
    restoredLastSeen,
    restartedEqualCursorUnreadHandled,
    recovered.messages,
  );
  const repeated = selectCursorMessages(
    "wxid_first",
    unreadChat,
    messages,
    restoredLastSeen,
    restartedEqualCursorUnreadHandled,
  );
  assert.deepEqual(repeated.messages, []);
});

test("handled cursor state retains only the latest cursor per chat", () => {
  const lastSeen = new Map<string, number>();
  const equalCursorUnreadHandled = new Map<string, number>();

  for (let localId = 1; localId <= 10_000; localId += 1) {
    advanceToHandledMessages(
      "wxid_first",
      lastSeen,
      equalCursorUnreadHandled,
      [message(localId)],
    );
  }

  assert.equal(equalCursorUnreadHandled.size, 1);
  assert.equal(equalCursorUnreadHandled.get("wxid_first"), 10_000);

  advanceToHandledMessages(
    "wxid_second",
    lastSeen,
    equalCursorUnreadHandled,
    [{ ...message(20_000), chatId: "wxid_second" }],
  );
  assert.equal(equalCursorUnreadHandled.size, 2);
  assert.equal(equalCursorUnreadHandled.get("wxid_first"), 10_000);
  assert.equal(equalCursorUnreadHandled.get("wxid_second"), 20_000);
});

test("advancing a chat replaces the stale handled cursor", () => {
  const lastSeen = new Map([["wxid_first", 7]]);
  const equalCursorUnreadHandled = new Map([["wxid_first", 7]]);

  advanceToHandledMessages(
    "wxid_first",
    lastSeen,
    equalCursorUnreadHandled,
    [message(8), message(9)],
  );

  assert.deepEqual([...equalCursorUnreadHandled.entries()], [["wxid_first", 9]]);
  const stale = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 9 }),
    [message(9)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(stale.messages, []);
});

test("normal non-first polls only select ids above the cursor", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 2, lastMsgLocalId: 3 }),
    [message(1), message(2), message(3)],
    new Map([["wxid_first", 1]]),
    new Map(),
  );
  assert.deepEqual(result.messages.map((m) => m.localId), [2, 3]);
});

test("equal cursor recovery is limited to the reported unread suffix", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 2 }),
    [message(1)],
    new Map([["wxid_first", 1]]),
    new Map(),
  );
  assert.deepEqual(result.messages, []);
});

test("first poll still seeds read history before the unread suffix", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 3 }),
    [message(1), message(2), message(3)],
    new Map(),
    new Map(),
  );
  assert.equal(result.seedLastSeen, 2);
  assert.deepEqual(result.messages.map((m) => m.localId), [3]);
});
