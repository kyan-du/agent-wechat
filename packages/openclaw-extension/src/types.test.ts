import assert from "node:assert/strict";
import test from "node:test";
import { resolveWeChatAccount } from "./types.ts";

test("resolveWeChatAccount defaults catch-up to latest (fold, do not drop)", () => {
  const account = resolveWeChatAccount({
    channels: { wechat: { serverUrl: "http://localhost:6174" } },
  });

  assert.equal(account?.catchUpMode, "latest");
  assert.equal(account?.catchUpMaxMessages, 10);
  assert.equal(account?.catchUpMaxAgeMs, 300_000);
  assert.equal(account?.catchUpChatBudget, 5);
  assert.equal(account?.mediaPartDelayMs, 750);
});

test("resolveWeChatAccount rejects unsafe numeric recovery values", () => {
  const account = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpMode: "latest",
        catchUpMaxMessages: 0,
        catchUpMaxAgeMs: 10,
        catchUpChatBudget: 0,
        mediaPartDelayMs: -1,
      },
    },
  });

  assert.equal(account?.catchUpMode, "latest");
  assert.equal(account?.catchUpMaxMessages, 10);
  assert.equal(account?.catchUpMaxAgeMs, 300_000);
  assert.equal(account?.catchUpChatBudget, 5);
  assert.equal(account?.mediaPartDelayMs, 750);
});

test("resolveWeChatAccount accepts a raised catch-up chat budget", () => {
  const account = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpChatBudget: 8,
      },
    },
  });
  assert.equal(account?.catchUpChatBudget, 8);
});
