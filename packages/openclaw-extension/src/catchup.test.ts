import test from "node:test";
import assert from "node:assert/strict";
import { decideCatchup, nextReconnectState, shouldFoldSegments, simulateReconnectPolls } from "./catchup.ts";

const now = 1_700_000_000_000;

test("live traffic always dispatches", () => {
  const d = decideCatchup({
    isReconnect: false,
    isGroup: true,
    mentioned: false,
    newestTimestampMs: now - 8 * 60 * 60 * 1000,
    nowMs: now,
    catchupDispatched: 99,
  });
  assert.equal(d.action, "dispatch");
  assert.equal(d.reason, "live");
});

test("stale group chatter is context-only", () => {
  const d = decideCatchup({
    isReconnect: true,
    isGroup: true,
    mentioned: false,
    newestTimestampMs: now - 5 * 60 * 60 * 1000,
    nowMs: now,
    catchupDispatched: 0,
  });
  assert.equal(d.action, "skip_stale");
});

test("stale DM or mention still folds into one reply", () => {
  const dm = decideCatchup({
    isReconnect: true,
    isGroup: false,
    mentioned: false,
    newestTimestampMs: now - 5 * 60 * 60 * 1000,
    nowMs: now,
    catchupDispatched: 0,
  });
  assert.equal(dm.action, "dispatch");
  assert.equal(dm.reason, "catchup_fold");

  const mention = decideCatchup({
    isReconnect: true,
    isGroup: true,
    mentioned: true,
    newestTimestampMs: now - 5 * 60 * 60 * 1000,
    nowMs: now,
    catchupDispatched: 0,
  });
  assert.equal(mention.action, "dispatch");
});

test("over-budget reconnect chats are held, not dispatched", () => {
  const d = decideCatchup({
    isReconnect: true,
    isGroup: false,
    mentioned: false,
    newestTimestampMs: now - 60_000,
    nowMs: now,
    catchupDispatched: 5,
    catchupBudget: 5,
  });
  assert.equal(d.action, "defer");
  assert.equal(d.reason, "catchup_hold");
});

test("reconnect folds segments", () => {
  assert.equal(shouldFoldSegments(true), true);
  assert.equal(shouldFoldSegments(false), false);
});

test("reconnect ends after a drain so later traffic is live", () => {
  assert.deepEqual(
    nextReconnectState({ reconnect: true, unreadCount: 0, deferred: 0, dispatched: 0 }),
    { reconnect: false, dispatched: 0 },
  );
  assert.deepEqual(
    nextReconnectState({ reconnect: true, unreadCount: 3, deferred: 2, dispatched: 1 }),
    { reconnect: true, dispatched: 1 },
  );
  assert.deepEqual(
    nextReconnectState({ reconnect: true, unreadCount: 1, deferred: 0, dispatched: 3 }),
    { reconnect: false, dispatched: 0 },
  );
  assert.deepEqual(
    nextReconnectState({ reconnect: true, unreadCount: 4, deferred: 4, dispatched: 5, budget: 5 }),
    { reconnect: true, dispatched: 5 },
  );
  const after = nextReconnectState({ reconnect: false, unreadCount: 2, deferred: 0, dispatched: 0 });
  assert.equal(after.reconnect, false);
  const live = decideCatchup({
    isReconnect: after.reconnect,
    isGroup: false,
    mentioned: false,
    newestTimestampMs: Date.now(),
    nowMs: Date.now(),
    catchupDispatched: after.dispatched,
  });
  assert.equal(live.reason, "live");
});

test("seven-chat reconnect caps at five and holds the rest without a live burst", () => {
  const run = simulateReconnectPolls(7, 5);
  assert.deepEqual(run.ticks.slice(0, 5), [1, 1, 1, 1, 1]);
  assert.ok(run.ticks.slice(5).every((n) => n === 0));
  assert.equal(run.dispatched, 5);
  assert.equal(run.reconnect, true);
});
