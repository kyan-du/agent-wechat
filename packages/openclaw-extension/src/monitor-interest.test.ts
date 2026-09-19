import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonitorInterest,
  monitorInterestFingerprint,
  shouldListChatsInterestOnly,
} from "./monitor-interest.ts";
import type { ResolvedWeChatAccount } from "./types.ts";

function account(partial: Partial<ResolvedWeChatAccount> = {}): ResolvedWeChatAccount {
  return {
    accountId: "default",
    enabled: true,
    serverUrl: "http://127.0.0.1:6174",
    dmPolicy: "allowlist",
    allowFrom: ["vangie", "wechat:jessie_hu"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["vangie"],
    groups: {},
    pollIntervalMs: 1000,
    authPollIntervalMs: 5000,
    catchUpMode: "read-only",
    catchUpMaxMessages: 50,
    catchUpMaxAgeMs: 86_400_000,
    catchUpChatBudget: 1,
    mediaPartDelayMs: 0,
    ...partial,
  };
}

test("buildMonitorInterest normalizes allowFrom prefixes", () => {
  const interest = buildMonitorInterest(account());
  assert.equal(interest.dmPolicy, "allowlist");
  assert.deepEqual(interest.dmAllowFrom, ["vangie", "jessie_hu"]);
  assert.equal(shouldListChatsInterestOnly(interest), true);
});

test("fingerprint changes when allowFrom changes", () => {
  const a = monitorInterestFingerprint(buildMonitorInterest(account()));
  const b = monitorInterestFingerprint(
    buildMonitorInterest(account({ allowFrom: ["vangie", "xyan_du"] })),
  );
  assert.notEqual(a, b);
});

test("open dmPolicy does not request interestOnly listing", () => {
  const interest = buildMonitorInterest(account({ dmPolicy: "open" }));
  assert.equal(shouldListChatsInterestOnly(interest), false);
});
