import assert from "node:assert/strict";
import test from "node:test";
import { hasOwnedContainer, isReconcileableContainer, isUsableLocalVolume } from "./lifecycle-policy.ts";

test("fixed-name containers require the CLI instance label", () => {
  const owned = { Id: "a".repeat(64), Image: "sha256:x", Config: { Labels: { "dev.visionclaw.agent-wechat.instance": "default" } } };
  assert.equal(hasOwnedContainer(owned), true);
  assert.equal(hasOwnedContainer({ ...owned, Config: { Labels: {} } }), false);
  assert.equal(hasOwnedContainer({ ...owned, Config: {} }), false);
});

test("legacy fixed-name containers reconcile only through trusted inventory", () => {
  const info = { Id: "a".repeat(64), Config: { Labels: {} } };
  assert.equal(isReconcileableContainer(info, { containerId: "a".repeat(64) }), true);
  assert.equal(isReconcileableContainer(info, { containerId: "b".repeat(64) }), false);
  assert.equal(isReconcileableContainer(info), false);
});

test("purge volumes require a local Docker driver", () => {
  assert.equal(isUsableLocalVolume({ Driver: "local" }), true);
  assert.equal(isUsableLocalVolume({ Driver: "custom" }), false);
});
