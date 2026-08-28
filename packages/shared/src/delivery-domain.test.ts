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

const { advanceDelivery, canAdvanceDelivery, createQueuedDelivery, deliveryAfterSend, observeDelivery } = await import("./delivery-domain.ts");

const at = (iso: string) => new Date(iso);
const observation = (timestamp = "2026-01-01T00:00:02Z", sender = "wxid_self") => ({
  chatId: "chat", localId: 8, serverId: 9, timestamp, type: 0x80000001, sender, content: "hello",
});

test("successful post-commit send enters submitted without claiming confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", at("2026-01-01T00:00:00Z"), "key-1");
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.commitAttempted, true);
  assert.deepEqual(attempt.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"]]);
});

test("matching observation confirms target, self sender, payload, and packed type", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", at("2026-01-01T00:00:00Z"));
  const result = await observeDelivery(attempt, observation(), at("2026-01-01T00:00:03Z"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.observedLocalId, 8);
  assert.deepEqual(result.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"], ["submitted", "observed_in_chat"], ["observed_in_chat", "confirmed"]]);
});

test("wrong target, sender, or payload is uncertain and never retried", async () => {
  const target = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date());
  assert.equal((await observeDelivery(target, { ...observation(), chatId: "other", timestamp: new Date().toISOString() }, new Date())).state, "uncertain");
  const sender = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date());
  assert.equal((await observeDelivery(sender, observation(new Date().toISOString(), "wxid_other"), new Date())).state, "uncertain");
  const payload = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date());
  assert.equal((await observeDelivery(payload, { ...observation(new Date().toISOString()), content: "different" }, new Date())).state, "uncertain");
});

test("advanceDelivery handles ordinary edges but cannot claim terminal outcomes", async () => {
  const queued = await createQueuedDelivery("chat", "hello", "wxid_self");
  const composing = await advanceDelivery(queued, "composing", "send_accepted");
  assert.equal(composing.state, "composing");
  assert.equal((await advanceDelivery(composing, "submitted", "send_accepted")).state, "submitted");
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", new Date());
  await assert.rejects(() => advanceDelivery(submitted, "observed_in_chat", "target_sender_and_payload_match"), /INVALID_DELIVERY_OBSERVATION_AUTHORITY/);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat", "target_sender_and_payload_match"), true);
});

test("terminal outcomes use the explicit send-result matrix", async () => {
  const cases = [
    [{ success: true, commitAttempted: true }, "submitted", "send_accepted"],
    [{ success: false, commitAttempted: true }, "uncertain", "post_commit_uncertain"],
    [{ success: false, commitAttempted: false }, "failed", "pre_commit_failure"],
  ] as const;
  for (const [result, state, reason] of cases) {
    const attempt = await deliveryAfterSend(result, "chat", "hello", "wxid_self", at("2026-01-01T00:00:00Z"));
    assert.equal(attempt.state, state);
    assert.equal(attempt.transitions[0]?.reason, reason);
  }
  assert.equal((await deliveryAfterSend({ success: true, commitAttempted: false }, "chat", "hello", "wxid_self", new Date())).state, "submitted");
});

test("observation validation rejects unsafe fields and chronology violations", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", at("2026-01-01T00:00:00Z"));
  await assert.rejects(() => observeDelivery(attempt, { ...observation(), localId: -1 }, at("2026-01-01T00:00:03Z")), /greater than or equal to 0/);
  await assert.rejects(() => observeDelivery(attempt, observation("2025-12-31T23:59:59Z"), at("2026-01-01T00:00:03Z")), /INVALID_DELIVERY_OBSERVATION_TIME/);
  await assert.rejects(() => observeDelivery(attempt, observation("2026-01-01T00:00:04Z"), at("2026-01-01T00:00:03Z")), /INVALID_DELIVERY_OBSERVATION_TIME/);
});

test("runtime validation rejects malformed histories and preserves immutable results", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", "wxid_self", at("2026-01-01T00:00:00Z"));
  const invalidOrigin = { ...attempt, transitions: [{ ...attempt.transitions[0], from: "submitted" as const }] };
  await assert.rejects(() => advanceDelivery(invalidOrigin, "submitted", "send_accepted"), /INVALID_DELIVERY_TRANSITION_ORIGIN/);
  const result = await observeDelivery(attempt, observation(), at("2026-01-01T00:00:03Z"));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.transitions), true);
  assert.throws(() => (result as any).targetChatId = "tampered", TypeError);
  const restored = JSON.parse(JSON.stringify(result));
  assert.equal((await observeDelivery(restored, { ...observation(), chatId: "other" }, at("2026-01-01T00:00:04Z"))).state, "confirmed");
});
