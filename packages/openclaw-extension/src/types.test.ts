import assert from "node:assert/strict";
import test from "node:test";
import { resolveWeChatAccount } from "./types.ts";

test("resolveWeChatAccount uses conservative catch-up defaults", () => {
  const account = resolveWeChatAccount({
    channels: { wechat: { serverUrl: "http://localhost:6174" } },
  });

  assert.equal(account?.catchUpMode, "read-only");
  assert.equal(account?.catchUpMaxMessages, 10);
  assert.equal(account?.catchUpMaxAgeMs, 300_000);
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
        mediaPartDelayMs: -1,
      },
    },
  });

  assert.equal(account?.catchUpMode, "latest");
  assert.equal(account?.catchUpMaxMessages, 10);
  assert.equal(account?.catchUpMaxAgeMs, 300_000);
  assert.equal(account?.mediaPartDelayMs, 750);
});
