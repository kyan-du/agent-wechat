import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonitorInterest,
  ensureMonitorInterestSynced,
  monitorInterestFingerprint,
  shouldListChatsInterestOnly,
} from "./monitor-interest.ts";
import type { ResolvedWeChatAccount } from "./types.ts";
import type { MonitorInterest, WeChatClient } from "@kyan-du/agent-wechat-shared";

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

function mockClient(opts: {
  get?: () => Promise<{ ok: boolean; interest: MonitorInterest | null }>;
  put?: (interest: MonitorInterest) => Promise<{ ok: boolean; interest: MonitorInterest }>;
}): WeChatClient {
  return {
    getMonitorInterest: opts.get ?? (async () => ({ ok: true, interest: null })),
    setMonitorInterest:
      opts.put ??
      (async (interest: MonitorInterest) => ({ ok: true, interest })),
  } as unknown as WeChatClient;
}

test("ensureMonitorInterestSynced PUTs when server interest is null", async () => {
  let putCount = 0;
  const client = mockClient({
    get: async () => ({ ok: true, interest: null }),
    put: async (interest) => {
      putCount += 1;
      return { ok: true, interest };
    },
  });
  const result = await ensureMonitorInterestSynced(client, account());
  assert.equal(result.synced, true);
  assert.equal(putCount, 1);
  assert.equal(shouldListChatsInterestOnly(result.interest) && result.synced, true);
});

test("ensureMonitorInterestSynced skips PUT when server already matches", async () => {
  const desired = buildMonitorInterest(account());
  let putCount = 0;
  const client = mockClient({
    get: async () => ({ ok: true, interest: desired }),
    put: async (interest) => {
      putCount += 1;
      return { ok: true, interest };
    },
  });
  const result = await ensureMonitorInterestSynced(client, account());
  assert.equal(result.synced, true);
  assert.equal(putCount, 0);
});

test("ensureMonitorInterestSynced returns synced=false on GET/PUT failure", async () => {
  const client = mockClient({
    get: async () => {
      throw new Error("connection refused");
    },
  });
  const result = await ensureMonitorInterestSynced(client, account());
  assert.equal(result.synced, false);
  // Callers must not enable interestOnly while unsynced.
  assert.equal(shouldListChatsInterestOnly(result.interest) && result.synced, false);
});

test("ensureMonitorInterestSynced re-PUTs after server wipe (null) even if config unchanged", async () => {
  const desired = buildMonitorInterest(account());
  let round = 0;
  let putCount = 0;
  const client = mockClient({
    get: async () => {
      round += 1;
      // First call: matched; second: wiped (server restart).
      if (round === 1) return { ok: true, interest: desired };
      return { ok: true, interest: null };
    },
    put: async (interest) => {
      putCount += 1;
      return { ok: true, interest };
    },
  });
  const first = await ensureMonitorInterestSynced(client, account());
  assert.equal(first.synced, true);
  assert.equal(putCount, 0);
  const second = await ensureMonitorInterestSynced(client, account());
  assert.equal(second.synced, true);
  assert.equal(putCount, 1);
});
