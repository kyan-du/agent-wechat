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

const { advanceDelivery, canAdvanceDelivery, createQueuedDelivery, deliveryAfterSend, isAllowedEdge, observeDelivery } = await import("./delivery-domain.ts");

const advance = (attempt: any, to: any, reason: any, now?: Date) => advanceDelivery(attempt, to, reason, now);

test("successful post-commit send enters submitted without claiming confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"), "key-1");
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.commitAttempted, true);
  assert.deepEqual(attempt.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"]]);
});

test("matching message observation confirms the exact target and payload", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"), undefined);
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "wxid_self", content: "hello" }, new Date("2026-01-01T00:00:03Z"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.observedLocalId, 8);
  assert.deepEqual(result.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"], ["submitted", "observed_in_chat"], ["observed_in_chat", "confirmed"]]);
});

test("matching packed message types are normalized before confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 0x80000001, sender: "wxid_self", content: "hello" });
  assert.equal(result.state, "confirmed");
});

test("wrong target or payload is uncertain and never retried automatically", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date(), undefined);
  assert.equal((await observeDelivery(attempt, { chatId: "other", localId: 1, serverId: 1, timestamp: new Date().toISOString(), type: 1, sender: "wxid_self", content: "hello" })).state, "uncertain");
  const freshAttempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date(), undefined);
  assert.equal((await observeDelivery(freshAttempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: new Date().toISOString(), type: 1, sender: "wxid_other", content: "hello" })).state, "uncertain");
  const anotherAttempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date(), undefined);
  assert.equal((await observeDelivery(anotherAttempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: new Date().toISOString(), type: 1, sender: "wxid_self", content: " different" })).state, "uncertain");
});

test("advanceDelivery records allowed edges and rejects skipped/backward edges", async () => {
  const queued = await createQueuedDelivery("chat", "hello", "wxid_self");
  const composing = await advance(queued, "composing", "send_accepted");
  assert.equal(composing.state, "composing");
  await assert.rejects(() => advance(composing, "submitted", "send_accepted"), /INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY/);
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: false }, "chat", "hello", "wxid_self", new Date(), undefined);
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
  assert.equal(isAllowedEdge("queued", "failed", "pre_commit_failure", false), true);
  assert.equal(canAdvanceDelivery("queued", "failed", "pre_commit_failure", false), true);
  assert.equal(canAdvanceDelivery("queued", "failed", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("submitted", "failed", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("observed_in_chat", "failed", "pre_commit_failure"), false);
  assert.equal(isAllowedEdge("queued", "uncertain", "post_commit_uncertain", true), true);
  assert.equal(canAdvanceDelivery("queued", "uncertain", "post_commit_uncertain", true), true);
  assert.equal(canAdvanceDelivery("queued", "uncertain", "post_commit_uncertain"), false);
});

test("delivery outcomes use an explicit initial state/cause matrix", async () => {
  const cases = [
    [{ success: true, commitAttempted: false }, "submitted", "send_accepted"],
    [{ success: true, commitAttempted: true }, "submitted", "send_accepted"],
    [{ success: false, commitAttempted: true }, "uncertain", "post_commit_uncertain"],
    [{ success: false, commitAttempted: false }, "failed", "pre_commit_failure"],
  ] as const;
  for (const [result, state, reason] of cases) {
    const attempt = await deliveryAfterSend(result, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
    assert.equal(attempt.state, state);
    assert.equal(attempt.transitions[0]?.reason, reason);
  }
  const valid = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  const malformed = { ...valid, state: "failed" as const, commitAttempted: true, initialOutcome: { source: "send_result" as const, success: false, commitAttempted: true }, transitions: [{ ...valid.transitions[0], to: "failed" as const, reason: "pre_commit_failure" as const }] };
  await assert.rejects(() => advance(malformed, "failed", "pre_commit_failure"), /INVALID_DELIVERY_INITIAL_OUTCOME|INVALID_DELIVERY_COMMIT_EVIDENCE/);

  const fabricatedSubmitted = {
    ...valid,
    state: "submitted" as const,
    initialOutcome: undefined,
    transitions: [{ ...valid.transitions[0], to: "submitted" as const, reason: "send_accepted" as const }],
  };
  await assert.rejects(() => advance(fabricatedSubmitted, "observed_in_chat", "target_sender_and_payload_match"), /INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY/);
});

test("advanceDelivery rejects terminal causes without matching commit evidence", async () => {
  const queued = await createQueuedDelivery("chat", "hello", "wxid_self");
  await assert.rejects(() => advance(queued, "uncertain", "post_commit_uncertain"), /INVALID_DELIVERY_COMMIT_EVIDENCE/);
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date(), undefined);
  assert.equal((await advance(submitted, "failed", "pre_commit_failure")).state, "submitted");
});

test("failed send outcomes survive round-trip while direct fabrication is rejected", async () => {
  const failed = await deliveryAfterSend({ success: false, commitAttempted: false }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  const restored = JSON.parse(JSON.stringify(failed));
  assert.equal((await advance(restored, "failed", "pre_commit_failure")).state, "failed");
  const clonedQueued = JSON.parse(JSON.stringify(await createQueuedDelivery("chat", "hello", "wxid_self")));
  const clonedFailure = { ...clonedQueued, state: "failed" as const, initialOutcome: undefined, transitions: [{ from: "queued" as const, to: "failed" as const, at: clonedQueued.createdAt, reason: "pre_commit_failure" as const }] };
  await assert.rejects(() => advance(clonedFailure, "failed", "pre_commit_failure"), /INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY|INVALID_DELIVERY_INITIAL_OUTCOME/);

  const queued = await createQueuedDelivery("chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  const fabricated = {
    ...queued,
    state: "failed" as const,
    updatedAt: "2026-01-01T00:00:01Z",
    transitions: [{ from: "queued" as const, to: "failed" as const, at: "2026-01-01T00:00:01Z", reason: "pre_commit_failure" as const }],
  };
  await assert.rejects(() => advance(fabricated, "failed", "pre_commit_failure"), /INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY|INVALID_DELIVERY_INITIAL_OUTCOME/);
});

test("final observations are schema-valid and deeply immutable", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "wxid_self", content: "hello" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.transitions), true);
  assert.equal(Object.isFrozen(result.transitions[0]), true);
  assert.equal(result.observedLocalId, 8);
  assert.throws(() => (result as any).targetChatId = "tampered", TypeError);
});

test("observation validation rejects unsafe IDs and timestamps", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"));
  await assert.rejects(() => observeDelivery(attempt, { chatId: "chat", localId: -1, serverId: 1, timestamp: "2026-01-01T00:00:01Z", type: 1, sender: "wxid_self", content: "hello" }), /Number must be greater than or equal to 0/);
  await assert.rejects(() => observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "invalid", type: 1, sender: "wxid_self", content: "hello" }), /Invalid datetime/);
});

test("observation chronology is bounded by attempt creation and observation time", async () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", createdAt);
  const observation = { chatId: "chat", localId: 1, serverId: 1, type: 1, sender: "wxid_self", content: "hello" };
  await assert.rejects(() => observeDelivery(attempt, { ...observation, timestamp: "2025-12-31T23:59:59Z" }, new Date("2026-01-01T00:00:02Z")), /INVALID_DELIVERY_OBSERVATION_TIME/);
  await assert.rejects(() => observeDelivery(attempt, { ...observation, timestamp: "2026-01-01T00:00:03Z" }, new Date("2026-01-01T00:00:02Z")), /INVALID_DELIVERY_OBSERVATION_TIME/);
  assert.equal((await observeDelivery(attempt, { ...observation, timestamp: "2026-01-01T00:00:01Z" }, new Date("2026-01-01T00:00:02Z"))).state, "confirmed");
});

test("runtime validation rejects impossible delivery history, times, and IDs", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date("2026-01-01T00:00:00Z"), undefined);
  const invalidTime = { ...attempt, updatedAt: "2026-01-01T00:00:00Z", transitions: [{ ...attempt.transitions[0], at: "2026-01-01T00:00:01Z" }] };
  await assert.rejects(() => advance(invalidTime, "submitted", "send_accepted"), /INVALID_DELIVERY_TRANSITION_EDGE|INVALID_DELIVERY_TRANSITION_TIME/);
  const invalidId = { ...attempt, state: "confirmed" as const, observedLocalId: -1, transitions: [...attempt.transitions, { from: "submitted" as const, to: "observed_in_chat" as const, at: "2026-01-01T00:00:01Z", reason: "target_sender_and_payload_match" as const }, { from: "observed_in_chat" as const, to: "confirmed" as const, at: "2026-01-01T00:00:02Z", reason: "observation_confirmed" as const }] };
  await assert.rejects(() => advance(invalidId, "confirmed", "observation_confirmed"), /Number must be greater than or equal to 0/);
  const staleUpdate = { ...attempt, updatedAt: "2025-12-31T23:59:59Z" };
  await assert.rejects(() => advance(staleUpdate, "submitted", "send_accepted"), /INVALID_DELIVERY_TIME/);

  const oversized = { ...attempt, targetChatId: "x".repeat(70_000) };
  await assert.rejects(() => advance(oversized, "submitted", "send_accepted"), /String must contain at most 512/);
  await assert.rejects(() => advance({ ...attempt, unexpected: true } as any, "submitted", "send_accepted"), /Unrecognized key/);
});
