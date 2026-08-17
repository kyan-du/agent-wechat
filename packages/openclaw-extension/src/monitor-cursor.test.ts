import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import {
  cursorMessageKey,
  markCursorMessagesHandled,
  selectCursorMessages,
  selectMessagesHandledAfterDispatch,
  type HandledCursor,
  type StartupBaseline,
} from "./monitor-cursor.ts";

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

function message(localId: number, timestamp = "2026-08-16T00:00:00.000Z"): Message {
  return {
    localId,
    serverId: localId,
    chatId: "wxid_first",
    type: 1,
    content: `m${localId}`,
    timestamp,
  };
}

function advanceToHandledMessages(
  chatId: string,
  lastSeen: Map<string, number>,
  equalCursorUnreadHandled: Map<string, HandledCursor>,
  messages: Message[],
): void {
  const cursor = markCursorMessagesHandled(chatId, messages, equalCursorUnreadHandled);
  if (cursor !== undefined) {
    lastSeen.set(chatId, cursor);
  }
}

test("restored cursor equal to first unread localId recovers exactly once", () => {
  const lastSeen = new Map([["wxid_first", 1]]);
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();
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
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();

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
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();

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
  const restartedEqualCursorUnreadHandled = new Map<string, HandledCursor>();
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
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();

  for (let localId = 1; localId <= 10_000; localId += 1) {
    advanceToHandledMessages(
      "wxid_first",
      lastSeen,
      equalCursorUnreadHandled,
      [message(localId)],
    );
  }

  assert.equal(equalCursorUnreadHandled.size, 1);
  assert.equal(equalCursorUnreadHandled.get("wxid_first")?.localId, 10_000);

  advanceToHandledMessages(
    "wxid_second",
    lastSeen,
    equalCursorUnreadHandled,
    [{ ...message(20_000), chatId: "wxid_second" }],
  );
  assert.equal(equalCursorUnreadHandled.size, 2);
  assert.equal(equalCursorUnreadHandled.get("wxid_first")?.localId, 10_000);
  assert.equal(equalCursorUnreadHandled.get("wxid_second")?.localId, 20_000);
});

test("advancing a chat replaces the stale handled cursor", () => {
  const lastSeen = new Map([["wxid_first", 7]]);
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();
  markCursorMessagesHandled("wxid_first", [message(7)], equalCursorUnreadHandled);

  advanceToHandledMessages(
    "wxid_first",
    lastSeen,
    equalCursorUnreadHandled,
    [message(8), message(9)],
  );

  assert.equal(equalCursorUnreadHandled.get("wxid_first")?.localId, 9);
  const stale = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 9 }),
    [message(9)],
    lastSeen,
    equalCursorUnreadHandled,
  );
  assert.deepEqual(stale.messages, []);
});

test("reused localId with a different message identity is recovered once", () => {
  const lastSeen = new Map([["wxid_first", 1]]);
  const equalCursorUnreadHandled = new Map<string, HandledCursor>();
  const oldMessage = message(1);
  markCursorMessagesHandled("wxid_first", [oldMessage], equalCursorUnreadHandled);

  const replacement = {
    ...message(1),
    serverId: 2002,
    timestamp: "2026-08-17T00:17:00.000Z",
    content: "wechat-local-e2e-001",
  };
  const unreadChat = chat({ unreadCount: 1, lastMsgLocalId: 1 });
  const recovered = selectCursorMessages(
    "wxid_first", unreadChat, [replacement], lastSeen, equalCursorUnreadHandled,
  );
  assert.deepEqual(recovered.messages, [replacement]);

  advanceToHandledMessages("wxid_first", lastSeen, equalCursorUnreadHandled, recovered.messages);
  const repeated = selectCursorMessages(
    "wxid_first", unreadChat, [replacement], lastSeen, equalCursorUnreadHandled,
  );
  assert.deepEqual(repeated.messages, []);
  assert.equal(equalCursorUnreadHandled.size, 1);
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

test("startup baseline treats a clock-skewed-behind newer row as live", () => {
  const baseline: StartupBaseline = { localId: 1 };
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 0, lastMsgLocalId: 1 }),
    [
      message(1, "2026-08-17T07:18:00.000Z"),
      message(2, "2026-08-17T07:17:59.000Z"),
    ],
    new Map(),
    new Map(),
    baseline,
  );

  assert.equal(result.firstPoll, true);
  assert.equal(result.prevLastSeen, 0);
  assert.equal(result.seedLastSeen, 1);
  assert.deepEqual(result.messages.map((m) => m.localId), [2]);
});

test("startup baseline suppresses stale future-skewed rows", () => {
  const baseline: StartupBaseline = { localId: 4 };
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 4 }),
    [
      message(1, "2026-08-17T07:00:00.000Z"),
      message(2, "2026-08-17T07:05:00.000Z"),
      message(3, "2026-08-17T07:10:00.000Z"),
      message(4, "2036-08-17T07:20:34.000Z"),
    ],
    new Map(),
    new Map(),
    baseline,
  );

  assert.equal(result.seedLastSeen, 4);
  assert.deepEqual(result.messages, []);
});

test("startup baseline uses ids for same-second and subsecond rows", () => {
  const baseline: StartupBaseline = { localId: 2 };
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 2 }),
    [
      message(1, "2026-08-17T07:18:00.000Z"),
      message(2, "2026-08-17T07:18:00.000Z"),
      message(3, "2026-08-17T07:18:00.250Z"),
    ],
    new Map(),
    new Map(),
    baseline,
  );

  assert.equal(result.seedLastSeen, 2);
  assert.deepEqual(result.messages.map((m) => m.localId), [3]);
});

test("startup baseline catches a message arriving between listChats and listMessages", () => {
  const baseline: StartupBaseline = { localId: 1 };
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 0, lastMsgLocalId: 1 }),
    [
      message(1, "2026-08-17T07:18:00.000Z"),
      message(2, "2026-08-17T07:18:00.000Z"),
    ],
    new Map(),
    new Map(),
    baseline,
  );

  assert.equal(result.seedLastSeen, 1);
  assert.deepEqual(result.messages.map((m) => m.localId), [2]);
});

test("post-initial first-seen chat can dispatch from an explicit zero baseline", () => {
  const baseline: StartupBaseline = { localId: 0 };
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 1 }),
    [message(1, "2036-08-17T07:20:34.000Z")],
    new Map(),
    new Map(),
    baseline,
  );

  assert.equal(result.seedLastSeen, undefined);
  assert.deepEqual(result.messages.map((m) => m.localId), [1]);
});

test("startup baseline detects local-id generation reset below the baseline", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 2 }),
    [message(1), message(2)],
    new Map(),
    new Map(),
    { localId: 100, messageKey: "old-generation" },
  );

  assert.equal(result.generationReset, true);
  assert.equal(result.seedLastSeen, 1);
  assert.deepEqual(result.messages.map((m) => m.localId), [2]);
});

test("startup baseline detects a reset generation that regrows to the same local id", () => {
  const oldBaseline = message(100);
  const resetMessages = Array.from({ length: 100 }, (_, index) => ({
    ...message(index + 1),
    serverId: 10_000 + index + 1,
    content: `reset-${index + 1}`,
  }));
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 100, lastMsgLocalId: 100 }),
    resetMessages,
    new Map(),
    new Map(),
    { localId: 100, messageKey: cursorMessageKey(oldBaseline) },
  );

  assert.equal(result.generationReset, true);
  assert.equal(result.seedLastSeen, undefined);
  assert.deepEqual(result.messages.map((m) => m.localId), Array.from({ length: 100 }, (_, i) => i + 1));
});

test("matching same-id startup baseline remains history and is not replayed", () => {
  const baselineMessage = message(100);
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 1, lastMsgLocalId: 100 }),
    [baselineMessage],
    new Map(),
    new Map(),
    { localId: 100, messageKey: cursorMessageKey(baselineMessage) },
  );

  assert.equal(result.generationReset, undefined);
  assert.equal(result.seedLastSeen, 100);
  assert.deepEqual(result.messages, []);
});

test("steady-state cursor detects local-id generation reset below the cursor", () => {
  const result = selectCursorMessages(
    "wxid_first",
    chat({ unreadCount: 2, lastMsgLocalId: 2 }),
    [message(1), message(2)],
    new Map([["wxid_first", 100]]),
    new Map(),
  );

  assert.equal(result.generationReset, true);
  assert.deepEqual(result.messages.map((m) => m.localId), [1, 2]);
});

test("dispatch failure only advances through successful prefix segments", () => {
  const handled = selectMessagesHandledAfterDispatch(
    [message(1), message(2), message(3)],
    [1],
  );

  assert.deepEqual(handled.map((m) => m.localId), [1]);
});

test("failed first segment leaves every segment retryable", () => {
  const handled = selectMessagesHandledAfterDispatch(
    [message(1), message(2), message(3)],
    [],
  );

  assert.deepEqual(handled, []);
});
