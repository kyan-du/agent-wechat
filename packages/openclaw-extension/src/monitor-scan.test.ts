import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, CursorPage, Message } from "@kyan-du/agent-wechat-shared";
import {
  listInitialMonitorChatSnapshot,
  listMessagesForMonitorCursor,
  listNextMonitorChatPage,
  type ChatScanState,
  type MessageScanContinuation,
} from "./monitor-scan.ts";
import { cursorMessageKey, type HandledCursor } from "./monitor-cursor.ts";

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
  return {
    id,
    username: id,
    name: id,
    unreadCount: 0,
    isGroup: false,
    lastMsgLocalId: 0,
    ...overrides,
  };
}

function message(localId: number): Message {
  return {
    localId,
    serverId: localId,
    chatId: "wxid_test",
    type: 1,
    content: `m${localId}`,
    timestamp: "2026-08-17T00:00:00.000Z",
  };
}

test("monitor chat scan follows nextCursor beyond the first page", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => chat(`wxid_${index + 1}`));
  const secondPage = [chat("wxid_101", { unreadCount: 1, lastMsgLocalId: 7 })];
  const calls: Array<{ limit?: number; cursor?: string }> = [];
  const client = {
    async listChatsPage(limit?: number, cursor?: string): Promise<CursorPage<Chat>> {
      calls.push({ limit, cursor });
      return cursor === "next"
        ? { schemaVersion: 1, items: secondPage }
        : { schemaVersion: 1, items: firstPage, nextCursor: "next" };
    },
  };
  const state: ChatScanState = { initialScanComplete: false };

  const first = await listNextMonitorChatPage(client, state);
  const second = await listNextMonitorChatPage(client, state);

  assert.equal(first.chats.length, 100);
  assert.equal(second.chats[0].username, "wxid_101");
  assert.equal(state.initialScanComplete, true);
  assert.deepEqual(calls, [
    { limit: 100, cursor: undefined },
    { limit: 100, cursor: "next" },
  ]);
});

test("initial chat snapshot freezes all pages before any chat processing", async () => {
  let firstPageRequested = false;
  const client = {
    async listChatsPage(_limit?: number, cursor?: string): Promise<CursorPage<Chat>> {
      if (!cursor) {
        firstPageRequested = true;
        return { schemaVersion: 1, items: [chat("wxid_1", { lastMsgLocalId: 1 })], nextCursor: "next" };
      }
      assert.equal(firstPageRequested, true);
      return { schemaVersion: 1, items: [chat("wxid_101", { unreadCount: 1, lastMsgLocalId: 7 })] };
    },
  };
  const state: ChatScanState = { initialScanComplete: false };
  const snapshot = await listInitialMonitorChatSnapshot(client, state);

  assert.deepEqual(snapshot.map((item) => item.lastMsgLocalId), [1, 7]);
  assert.equal(state.initialScanComplete, true);
});

test("message scan crosses recovery window and API page boundary before completing", async () => {
  const pages = [
    Array.from({ length: 200 }, (_, index) => message(205 - index)),
    Array.from({ length: 5 }, (_, index) => message(5 - index)),
  ];
  const cursors: Array<string | undefined> = [];
  const client = {
    async listMessagesPage(
      _chatId: string,
      _limit?: number,
      cursor?: string,
    ): Promise<CursorPage<Message>> {
      cursors.push(cursor);
      return cursor === "older"
        ? { schemaVersion: 1, items: pages[1] }
        : { schemaVersion: 1, items: pages[0], nextCursor: "older" };
    },
  };

  const scan = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 205, lastMsgLocalId: 205 }),
    firstPoll: false,
    prevLastSeen: 0,
  });

  assert.equal(scan.complete, true);
  assert.equal(scan.messages.length, 205);
  assert.deepEqual(cursors, [undefined, "older"]);
});

test("steady-state equal-ID reset scan reads the complete unread generation", async () => {
  const pages = [
    Array.from({ length: 40 }, (_, index) => message(100 - index)),
    Array.from({ length: 60 }, (_, index) => message(60 - index)),
  ];
  const cursors: Array<string | undefined> = [];
  const client = {
    async listMessagesPage(
      _chatId: string,
      _limit?: number,
      cursor?: string,
    ): Promise<CursorPage<Message>> {
      cursors.push(cursor);
      return cursor === "older"
        ? { schemaVersion: 1, items: pages[1] }
        : { schemaVersion: 1, items: pages[0], nextCursor: "older" };
    },
  };

  const scan = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 100, lastMsgLocalId: 100 }),
    firstPoll: false,
    prevLastSeen: 100,
    handledCursor: { localId: 100, messageKey: "old-generation" },
  });

  assert.equal(scan.complete, true);
  assert.equal(scan.messages.length, 100);
  assert.deepEqual(cursors, [undefined, "older"]);
});

test("equal-ID reset paging ignores an underreported unread counter", async () => {
  const oldCursor = message(100);
  const resetCursor = { ...message(100), serverId: 20_100, content: "new-100" };
  const client = {
    async listMessagesPage(
      _chatId: string,
      _limit?: number,
      cursor?: string,
    ): Promise<CursorPage<Message>> {
      if (cursor === "older-generation") {
        return { schemaVersion: 1, items: [message(500)] };
      }
      if (cursor === "older-reset") {
        return {
          schemaVersion: 1,
          items: Array.from({ length: 60 }, (_, index) => message(60 - index)),
          nextCursor: "older-generation",
        };
      }
      return {
        schemaVersion: 1,
        items: [resetCursor, ...Array.from({ length: 39 }, (_, index) => message(99 - index))],
        nextCursor: "older-reset",
      };
    },
  };
  const handledCursor: HandledCursor = {
    localId: 100,
    messageKey: cursorMessageKey(oldCursor),
  };

  const scan = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 1, lastMsgLocalId: 100 }),
    firstPoll: false,
    prevLastSeen: 100,
    handledCursor,
  });

  assert.equal(scan.complete, true);
  assert.equal(scan.generationReset, true);
  assert.deepEqual(
    [...scan.messages].sort((a, b) => a.localId - b.localId).map((item) => item.localId),
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
});

test("reset continuation survives unread dropping to zero", async () => {
  const firstPage = [{ ...message(100), serverId: 20_100, content: "new-100" }];
  const continuation: MessageScanContinuation = {
    chat: chat("wxid_test", { unreadCount: 1, lastMsgLocalId: 100 }),
    cursor: "older-reset",
    messages: firstPage,
    generationReset: true,
  };
  const client = {
    async listMessagesPage(
      _chatId: string,
      _limit?: number,
      cursor?: string,
    ): Promise<CursorPage<Message>> {
      assert.equal(cursor, "older-reset");
      return {
        schemaVersion: 1,
        items: Array.from({ length: 99 }, (_, index) => message(99 - index)),
      };
    },
  };

  const scan = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 0, lastMsgLocalId: 100 }),
    firstPoll: false,
    prevLastSeen: 100,
    continuation,
  });

  assert.equal(scan.complete, true);
  assert.equal(scan.generationReset, true);
  assert.equal(scan.messages.length, 100);
});

test("message scan can be durably continued without dropping the first page", async () => {
  const client = {
    async listMessagesPage(
      _chatId: string,
      _limit?: number,
      cursor?: string,
    ): Promise<CursorPage<Message>> {
      return cursor === "older"
        ? { schemaVersion: 1, items: [message(1)] }
        : { schemaVersion: 1, items: [message(3), message(2)], nextCursor: "older" };
    },
  };

  const first = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 3, lastMsgLocalId: 3 }),
    firstPoll: false,
    prevLastSeen: 0,
    pageBudget: 1,
  });
  assert.equal(first.complete, false);
  assert.deepEqual(first.messages.map((item) => item.localId), [3, 2]);

  const second = await listMessagesForMonitorCursor(client, "wxid_test", {
    chat: chat("wxid_test", { unreadCount: 3, lastMsgLocalId: 3 }),
    firstPoll: false,
    prevLastSeen: 0,
    continuation: {
      chat: chat("wxid_test", { unreadCount: 3, lastMsgLocalId: 3 }),
      cursor: first.nextCursor,
      messages: first.messages,
    },
  });

  assert.equal(second.complete, true);
  assert.deepEqual(second.messages.map((item) => item.localId), [3, 2, 1]);
});
