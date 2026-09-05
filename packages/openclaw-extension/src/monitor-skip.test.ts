import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Chat } from "@kyan-du/agent-wechat-shared";
import {
  applyEmptyUnreadSkip,
  EMPTY_UNREAD_BACKOFF_MAX_MS,
  EMPTY_UNREAD_BACKOFF_MS,
  isEmptyUnreadBackoffActive,
  isOfficialAccount,
} from "./monitor-skip.ts";

function chat(id: string, unreadCount: number): Chat {
  return {
    id,
    username: id,
    name: id,
    unreadCount,
    isGroup: false,
  };
}

test("isOfficialAccount skips gh_ official accounts and known system chats", () => {
  assert.equal(isOfficialAccount("gh_news"), true);
  assert.equal(isOfficialAccount("newsapp"), true);
  assert.equal(isOfficialAccount("filehelper"), true);
  assert.equal(isOfficialAccount("fmessage"), true);
  assert.equal(isOfficialAccount("medianote"), true);
  assert.equal(isOfficialAccount("weixin"), true);
  assert.equal(isOfficialAccount("wxid_user"), false);
  assert.equal(isOfficialAccount("34438530917@chatroom"), false);
});

test("unread filter drops gh_/system chats but keeps newsapp (feed delivery)", () => {
  const chats = [
    chat("newsapp", 7),
    chat("gh_service", 3),
    chat("filehelper", 1),
    chat("wxid_friend", 2),
    chat("wxid_quiet", 0),
  ];
  const unread = chats.filter((c) => {
    if (c.unreadCount <= 0) return false;
    if (c.username === "newsapp") return true;
    return !isOfficialAccount(c.username ?? c.id);
  });
  assert.deepEqual(unread.map((item) => item.username), ["newsapp", "wxid_friend"]);
});

test("empty unread firstPoll seeds lastSeen and backs off instead of looping at poll rate", () => {
  const lastSeenId = new Map<string, number>();
  const backoff = new Map();
  const now = 1_000;

  const first = applyEmptyUnreadSkip("newsapp", {
    unreadCount: 7,
    firstPoll: true,
    prevLastSeen: 0,
    lastSeenId,
    backoff,
    now,
  });

  assert.deepEqual(first, { seededLastSeen: true, backoffMs: EMPTY_UNREAD_BACKOFF_MS });
  assert.equal(lastSeenId.has("newsapp"), true);
  assert.equal(lastSeenId.get("newsapp"), 0);
  assert.equal(isEmptyUnreadBackoffActive(backoff, "newsapp", now + EMPTY_UNREAD_BACKOFF_MS - 1), true);
  assert.equal(isEmptyUnreadBackoffActive(backoff, "newsapp", now + EMPTY_UNREAD_BACKOFF_MS), false);

  const second = applyEmptyUnreadSkip("newsapp", {
    unreadCount: 7,
    firstPoll: false,
    prevLastSeen: 0,
    lastSeenId,
    backoff,
    now: now + EMPTY_UNREAD_BACKOFF_MS,
  });
  assert.equal(second?.seededLastSeen, false);
  assert.equal(second?.backoffMs, EMPTY_UNREAD_BACKOFF_MS * 2);
  assert.equal(lastSeenId.get("newsapp"), 0);
});

test("empty fetch with unreadCount 0 does not seed lastSeen or start backoff", () => {
  const lastSeenId = new Map<string, number>();
  const backoff = new Map();
  const result = applyEmptyUnreadSkip("wxid_friend", {
    unreadCount: 0,
    firstPoll: true,
    prevLastSeen: 0,
    lastSeenId,
    backoff,
    now: 0,
  });
  assert.equal(result, null);
  assert.equal(lastSeenId.has("wxid_friend"), false);
  assert.equal(backoff.size, 0);
});

test("monitor wires official/system skip and empty unread backoff", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "monitor.ts"), "utf8");
  assert.match(source, /from "\.\/monitor-skip\.js"/);
  assert.match(source, /isNewsappChat\(c\)/);
  assert.match(source, /applyEmptyUnreadSkip\(chatId/);
  assert.doesNotMatch(source, /function isOfficialAccount/);
});

test("empty unread backoff caps at 60s", () => {
  const lastSeenId = new Map<string, number>([["wxid_friend", 0]]);
  const backoff = new Map();
  let now = 0;
  let lastMs = 0;
  for (let i = 0; i < 8; i += 1) {
    const result = applyEmptyUnreadSkip("wxid_friend", {
      unreadCount: 1,
      firstPoll: false,
      prevLastSeen: 0,
      lastSeenId,
      backoff,
      now,
    });
    lastMs = result?.backoffMs ?? 0;
    now += lastMs;
  }
  assert.equal(lastMs, EMPTY_UNREAD_BACKOFF_MAX_MS);
});
