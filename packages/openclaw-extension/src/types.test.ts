import assert from "node:assert/strict";
import test from "node:test";
import { resolveWeChatAccount } from "./types.ts";

test("resolveWeChatAccount defaults catch-up to read-only", () => {
  const account = resolveWeChatAccount({
    channels: { wechat: { serverUrl: "http://localhost:6174" } },
  });

  assert.equal(account?.catchUpMode, "read-only");
  assert.equal(account?.catchUpMaxMessages, 10);
  assert.equal(account?.catchUpMaxAgeMs, 300_000);
  assert.equal(account?.catchUpChatBudget, 5);
  assert.equal(account?.mediaPartDelayMs, 750);
});

test("resolveWeChatAccount only opts into latest on the exact string", () => {
  const absent = resolveWeChatAccount({
    channels: { wechat: { serverUrl: "http://localhost:6174" } },
  });
  const invalid = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpMode: 1 as unknown as "latest",
      },
    },
  });
  const typedWrong = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpMode: "LIVE" as unknown as "latest",
      },
    },
  });
  const readOnly = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpMode: "read-only",
      },
    },
  });
  const latest = resolveWeChatAccount({
    channels: {
      wechat: {
        serverUrl: "http://localhost:6174",
        catchUpMode: "latest",
      },
    },
  });

  assert.equal(absent?.catchUpMode, "read-only");
  assert.equal(invalid?.catchUpMode, "read-only");
  assert.equal(typedWrong?.catchUpMode, "read-only");
  assert.equal(readOnly?.catchUpMode, "read-only");
  assert.equal(latest?.catchUpMode, "latest");
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
