import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./schemas/index.js" && context.parentURL?.endsWith("/src/delivery-domain.ts")) {
      return nextResolve("./schemas/index.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { advanceDelivery, canAdvanceDelivery, createTrustedSenderProvenance, deliveryAfterSend, observeDelivery } = await import("./delivery-domain.ts");

test("successful post-commit send enters submitted without claiming confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), "key-1", createTrustedSenderProvenance("account", "session", "wxid_self"));
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.commitAttempted, true);
  assert.deepEqual(attempt.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"]]);
});

test("matching message observation confirms the exact target and payload", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), undefined, createTrustedSenderProvenance("account", "session", "wxid_self"));
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "wxid_self", content: "hello" }, new Date("2026-01-01T00:00:03Z"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.observedLocalId, 8);
  assert.deepEqual(result.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"], ["submitted", "observed_in_chat"], ["observed_in_chat", "confirmed"]]);
});

test("wrong target or payload is uncertain and never retried automatically", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date(), undefined, createTrustedSenderProvenance("account", "session", "wxid_self"));
  assert.equal((await observeDelivery(attempt, { chatId: "other", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_self", content: "hello" })).state, "uncertain");
  assert.equal((await observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_other", content: "hello" })).state, "uncertain");
  assert.equal((await observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_self", content: " different" })).state, "uncertain");
});

test("advanceDelivery records allowed edges and rejects skipped/backward edges", async () => {
  const submitted = await deliveryAfterSend({ success: true, commitAttempted: false }, "chat", "hello", new Date(), undefined, createTrustedSenderProvenance("account", "session", "wxid_self"));
  assert.equal(advanceDelivery(submitted, "confirmed", "observation_confirmed").state, "submitted");
  const observed = advanceDelivery(submitted, "observed_in_chat", "target_sender_and_payload_match");
  assert.equal(observed.state, "observed_in_chat");
  assert.equal(advanceDelivery(observed, "confirmed", "observation_confirmed").state, "confirmed");
  assert.equal(canAdvanceDelivery("queued", "composing", "observation_confirmed"), false);
  assert.equal(canAdvanceDelivery("composing", "submitted", "observation_confirmed"), false);
});

test("terminal outcomes cannot advance", () => {
  assert.equal(canAdvanceDelivery("confirmed", "submitted", "send_accepted"), false);
  assert.equal(canAdvanceDelivery("uncertain", "confirmed", "observation_confirmed"), false);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat", "target_sender_and_payload_match"), true);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat", "pre_commit_failure"), false);
  assert.equal(canAdvanceDelivery("observed_in_chat", "confirmed", "sender_unverified"), false);
});
