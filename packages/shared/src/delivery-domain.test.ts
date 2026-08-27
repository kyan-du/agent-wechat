import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/packages/shared/src/")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createAuthenticatedSessionAdapter, restoreAuthenticatedSessionAdapter } = await import("./internal/authenticated-session.ts");
const { advanceDelivery, canAdvanceDelivery, createAuthenticatedSenderBoundary, createQueuedDelivery, issueTrustedSenderProvenance, deliveryAfterSend, observeDelivery } = await import("./delivery-domain.ts");

function testBackend() {
  let persisted: any;
  return {
    read: () => persisted,
    compareAndSwap: (expectedRevision: number | null, snapshot: any) => {
      if ((persisted?.revision ?? null) !== expectedRevision) return false;
      persisted = structuredClone(snapshot);
      return true;
    },
  };
}

const sessionAdapter = createAuthenticatedSessionAdapter(
  () => ({ accountId: "account", sessionId: "session", senderId: "wxid_self" }),
  testBackend(),
);
const authenticatedBoundary = createAuthenticatedSenderBoundary(sessionAdapter.capability);
const trusted = (verifiedAt = new Date("2025-01-01T00:00:00Z")) => issueTrustedSenderProvenance(authenticatedBoundary, verifiedAt);
const advance = (attempt: any, to: any, reason: any, now?: Date) => advanceDelivery(attempt, to, reason, trusted(), now);

test("successful post-commit send enters submitted without claiming confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), "key-1", trusted());
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.commitAttempted, true);
  assert.deepEqual(attempt.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"]]);
});

test("matching message observation confirms the exact target and payload", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, trusted());
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "wxid_self", content: "hello" }, trusted(), new Date("2026-01-01T00:00:03Z"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.observedLocalId, 8);
  assert.deepEqual(result.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"], ["submitted", "observed_in_chat"], ["observed_in_chat", "confirmed"]]);
});

test("wrong target or payload is uncertain and never retried automatically", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date(), undefined, trusted());
  assert.equal((await observeDelivery(attempt, { chatId: "other", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_self", content: "hello" }, trusted())).state, "uncertain");
  assert.equal((await observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_other", content: "hello" }, trusted())).state, "uncertain");
  assert.equal((await observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_self", content: " different" }, trusted())).state, "uncertain");
});

test("advanceDelivery records allowed edges and rejects skipped/backward edges", async () => {
  const queued = await createQueuedDelivery("chat", "hello", trusted());
  const composing = await advance(queued, "composing", "send_accepted");
  assert.equal(composing.state, "composing");
  assert.equal((await advance(composing, "submitted", "send_accepted")).state, "submitted");
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: false }, "chat", "hello", new Date(), undefined, trusted());
  assert.equal((await advance(submitted, "confirmed", "observation_confirmed")).state, "submitted");
  const observed = await advance(submitted, "observed_in_chat", "target_sender_and_payload_match");
  assert.equal(observed.state, "observed_in_chat");
  assert.equal((await advance(observed, "confirmed", "observation_confirmed")).state, "confirmed");
  assert.equal(canAdvanceDelivery("queued", "composing", "observation_confirmed"), false);
  assert.equal(canAdvanceDelivery("composing", "submitted", "observation_confirmed"), false);
});

test("terminal outcomes and semantically invalid causes are rejected", () => {
  assert.equal(canAdvanceDelivery("confirmed", "submitted", "send_accepted"), false);
  assert.equal(canAdvanceDelivery("uncertain", "confirmed", "observation_confirmed"), false);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat", "target_sender_and_payload_match"), true);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("observed_in_chat", "confirmed", "sender_unverified"), false);
  assert.equal(canAdvanceDelivery("queued", "failed", "pre_commit_failure"), true);
  assert.equal(canAdvanceDelivery("submitted", "failed", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("observed_in_chat", "failed", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("queued", "uncertain", "post_commit_uncertain"), true);
});

test("advanceDelivery rejects terminal causes without matching commit evidence", async () => {
  const queued = await createQueuedDelivery("chat", "hello", trusted());
  await assert.rejects(() => advance(queued, "uncertain", "post_commit_uncertain"), /INVALID_DELIVERY_COMMIT_EVIDENCE/);
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date(), undefined, trusted());
  await assert.rejects(() => advance(submitted, "failed", "pre_commit_failure"), /INVALID_DELIVERY_COMMIT_EVIDENCE/);
});

test("sender provenance requires the authenticated session capability", async () => {
  assert.throws(
    () => createAuthenticatedSenderBoundary({} as never),
    /UNAUTHENTICATED_SESSION_CAPABILITY/,
  );

  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, trusted());
  const forgedAttempt = { ...attempt, senderId: "attacker", senderAccountId: "attacker-account", senderSessionId: "attacker-session" };
  await assert.rejects(
    () => observeDelivery(forgedAttempt, {
      chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1,
      sender: "attacker", content: "hello",
    }, trusted()),
    /REVOKED_SENDER_PROVENANCE/,
  );

  await assert.rejects(
    () => observeDelivery({ ...attempt, senderId: "attacker" }, {
      chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1,
      sender: "attacker", content: "hello",
    }, trusted()),
    /REVOKED_SENDER_PROVENANCE/,
  );

  for (const tampered of [
    { ...attempt, targetChatId: "attacker-chat" },
    { ...attempt, payloadDigest: "0".repeat(64) },
  ]) {
    await assert.rejects(
      () => observeDelivery(tampered, {
        chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1,
        sender: "wxid_self", content: "hello",
      }, trusted()),
      /TAMPERED_DELIVERY_ATTEMPT/,
    );
  }
});

test("persisted attempts survive adapter restoration with the protected key state", async () => {
  let persisted: any;
  const backend = { read: () => persisted, compareAndSwap: (expectedRevision: number | null, snapshot: any) => {
    if ((persisted?.revision ?? null) !== expectedRevision) return false;
    persisted = structuredClone(snapshot);
    return true;
  } };
  const originalAdapter = createAuthenticatedSessionAdapter(() => ({ accountId: "restart-account", sessionId: "restart-session", senderId: "wxid_restart" }), backend);
  const originalBoundary = createAuthenticatedSenderBoundary(originalAdapter.capability);
  const originalProvenance = issueTrustedSenderProvenance(originalBoundary, new Date("2025-01-01T00:00:00Z"));
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "restart-chat", "restart payload", new Date("2026-01-01T00:00:00Z"), undefined, originalProvenance);
  const serialized = JSON.parse(JSON.stringify(attempt));
  const restoredAdapter = restoreAuthenticatedSessionAdapter(() => ({ accountId: "restart-account", sessionId: "restart-session", senderId: "wxid_restart" }), backend);
  const restoredProvenance = issueTrustedSenderProvenance(createAuthenticatedSenderBoundary(restoredAdapter.capability), new Date("2025-01-01T00:00:00Z"));
  const confirmed = await observeDelivery(serialized, { chatId: "restart-chat", localId: 4, serverId: 5, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "wxid_restart", content: "restart payload" }, restoredProvenance, new Date("2026-01-01T00:00:03Z"));
  assert.equal(confirmed.state, "confirmed");
  restoredAdapter.revoke();
  assert.throws(() => restoreAuthenticatedSessionAdapter(() => ({ accountId: "restart-account", sessionId: "restart-session", senderId: "wxid_restart" }), backend), /REVOKED_AUTHENTICATED_SESSION/);
});

test("rotating a session revokes old attempts and restores only the new generation", async () => {
  let persisted: any;
  const backend = { read: () => persisted, compareAndSwap: (expectedRevision: number | null, snapshot: any) => {
    if ((persisted?.revision ?? null) !== expectedRevision) return false;
    persisted = structuredClone(snapshot);
    return true;
  } };
  const adapter = createAuthenticatedSessionAdapter(() => ({ accountId: "rotate-account", sessionId: "rotate-session", senderId: "wxid_rotate" }), backend);
  const oldProvenance = issueTrustedSenderProvenance(createAuthenticatedSenderBoundary(adapter.capability), new Date("2025-01-01T00:00:00Z"));
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, oldProvenance);
  const nextAdapter = adapter.rotate();
  await assert.rejects(() => observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1, sender: "wxid_rotate", content: "hello" }, oldProvenance), /UNTRUSTED_SENDER_PROVENANCE/);
  const nextProvenance = issueTrustedSenderProvenance(createAuthenticatedSenderBoundary(nextAdapter.capability), new Date("2025-01-01T00:00:00Z"));
  await assert.rejects(() => observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1, sender: "wxid_rotate", content: "hello" }, nextProvenance), /UNKNOWN_AUTHENTICATED_SESSION_KEY/);
  const restoredCurrent = restoreAuthenticatedSessionAdapter(() => ({ accountId: "rotate-account", sessionId: "rotate-session", senderId: "wxid_rotate" }), backend);
  assert.ok(restoredCurrent.capability);
});

test("session logout and re-authentication revoke old provenance", async () => {
  let identity = { accountId: "account-before", sessionId: "session-before", senderId: "wxid_before" };
  const backend = testBackend();
  const adapter = createAuthenticatedSessionAdapter(() => identity, backend);
  const oldProvenance = issueTrustedSenderProvenance(createAuthenticatedSenderBoundary(adapter.capability), new Date("2025-01-01T00:00:00Z"));
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, oldProvenance);
  identity = { accountId: "account-after", sessionId: "session-after", senderId: "wxid_after" };
  await assert.rejects(() => observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1, sender: "wxid_before", content: "hello" }, oldProvenance), /REVOKED_SENDER_PROVENANCE/);
  adapter.revoke();
  assert.throws(() => createAuthenticatedSenderBoundary(adapter.capability), /UNAUTHENTICATED_SESSION_CAPABILITY/);
  assert.throws(() => createAuthenticatedSessionAdapter(() => identity, backend), /REVOKED_AUTHENTICATED_SESSION/);
});

test("stale authenticated session stores cannot overwrite a newer generation", () => {
  let persisted: any;
  const backend = { read: () => persisted, compareAndSwap: (expectedRevision: number | null, snapshot: any) => {
    if ((persisted?.revision ?? null) !== expectedRevision) return false;
    persisted = structuredClone(snapshot);
    return true;
  } };
  const first = createAuthenticatedSessionAdapter(() => ({ accountId: "race-account", sessionId: "race-session", senderId: "wxid_race" }), backend);
  const staleSnapshot = structuredClone(persisted);
  const staleBackend = {
    read: () => staleSnapshot,
    compareAndSwap: (expectedRevision: number | null, snapshot: any) => backend.compareAndSwap(expectedRevision, snapshot),
  };
  const second = restoreAuthenticatedSessionAdapter(() => ({ accountId: "race-account", sessionId: "race-session", senderId: "wxid_race" }), staleBackend);
  const rotated = first.rotate();
  assert.throws(() => second.rotate(), /CONCURRENT_AUTHENTICATED_SESSION_UPDATE/);
  assert.ok(rotated.capability);
});

test("store persistence rejects replayed or malformed authenticated state", async () => {
  let persisted: any;
  const backend = { read: () => persisted, compareAndSwap: (expectedRevision: number | null, snapshot: any) => {
    if ((persisted?.revision ?? null) !== expectedRevision) return false;
    persisted = structuredClone(snapshot);
    return true;
  } };
  const adapter = createAuthenticatedSessionAdapter(() => ({ accountId: "persist-account", sessionId: "persist-session", senderId: "wxid_persist" }), backend);
  adapter.revoke();
  assert.equal(persisted.closed, true);
  assert.throws(() => restoreAuthenticatedSessionAdapter(() => ({ accountId: "persist-account", sessionId: "persist-session", senderId: "wxid_persist" }), backend), /REVOKED_AUTHENTICATED_SESSION/);
  assert.throws(() => createAuthenticatedSessionAdapter(() => ({ accountId: "persist-account", sessionId: "persist-session", senderId: "wxid_persist" }), { read: () => ({ ...persisted, current: { ...persisted.current, integrityKey: "bad" } }), compareAndSwap: () => false } as any), /INVALID_AUTHENTICATED_SESSION_STORE/);
});

test("runtime validation rejects impossible delivery history, times, and IDs", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, trusted());
  const invalidTime = { ...attempt, updatedAt: "2026-01-01T00:00:00Z", transitions: [{ ...attempt.transitions[0], at: "2026-01-01T00:00:01Z" }] };
  await assert.rejects(() => advance(invalidTime, "submitted", "send_accepted"), /INVALID_DELIVERY_TRANSITION_TIME/);
  const invalidId = { ...attempt, state: "confirmed" as const, observedLocalId: -1, transitions: [...attempt.transitions, { from: "submitted" as const, to: "observed_in_chat" as const, at: "2026-01-01T00:00:01Z", reason: "target_sender_and_payload_match" as const }, { from: "observed_in_chat" as const, to: "confirmed" as const, at: "2026-01-01T00:00:02Z", reason: "observation_confirmed" as const }] };
  await assert.rejects(() => advance(invalidId, "confirmed", "observation_confirmed"), /Number must be greater than or equal to 0/);
  const staleUpdate = { ...attempt, updatedAt: "2025-12-31T23:59:59Z" };
  await assert.rejects(() => advance(staleUpdate, "submitted", "send_accepted"), /INVALID_DELIVERY_TIME/);

  const oversized = { ...attempt, targetChatId: "x".repeat(70_000) };
  await assert.rejects(() => advance(oversized, "submitted", "send_accepted"), /DELIVERY_ATTEMPT_TOO_LARGE/);
  await assert.rejects(() => advance({ ...attempt, unexpected: true } as any, "submitted", "send_accepted"), /INVALID_DELIVERY_ATTEMPT_INPUT/);
  const cyclic = { ...attempt } as any;
  cyclic.transitions = [cyclic];
  await assert.rejects(() => advance(cyclic, "submitted", "send_accepted"), /CYCLIC_DELIVERY_ATTEMPT/);
});
