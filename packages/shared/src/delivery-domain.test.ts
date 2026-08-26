import assert from "node:assert/strict";
import test from "node:test";
import { canAdvanceDelivery, deliveryAfterSend, observeDelivery } from "./delivery-domain.ts";

test("successful post-commit send enters submitted without claiming confirmation", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"), "key-1");
  assert.equal(attempt.state, "submitted");
  assert.equal(attempt.commitAttempted, true);
  assert.deepEqual(attempt.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"]]);
});

test("matching message observation confirms the exact target and payload", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello", new Date("2026-01-01T00:00:00Z"));
  const result = await observeDelivery(attempt, { chatId: "chat", localId: 8, serverId: 9, timestamp: "2026-01-01T00:00:02Z", type: 1, sender: "self", content: "hello" }, new Date("2026-01-01T00:00:03Z"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.observedLocalId, 8);
  assert.deepEqual(result.transitions.map((transition) => [transition.from, transition.to]), [["queued", "submitted"], ["submitted", "confirmed"]]);
});

test("wrong target or payload is uncertain and never retried automatically", async () => {
  const attempt = await deliveryAfterSend({ success: true, commitAttempted: true }, "chat", "hello");
  assert.equal((await observeDelivery(attempt, { chatId: "other", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, content: "hello" })).state, "uncertain");
  assert.equal((await observeDelivery(attempt, { chatId: "chat", localId: 1, serverId: 1, timestamp: "2026-01-01T00:00:00Z", type: 1, content: "different" })).state, "uncertain");
});

test("terminal outcomes cannot advance", () => {
  assert.equal(canAdvanceDelivery("confirmed", "submitted"), false);
  assert.equal(canAdvanceDelivery("uncertain", "confirmed"), false);
  assert.equal(canAdvanceDelivery("submitted", "observed_in_chat"), true);
});
