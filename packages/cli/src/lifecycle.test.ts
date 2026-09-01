import assert from "node:assert/strict";
import test from "node:test";
import { hasOwnedContainer, hasOwnedVolume, isReconcileableContainer } from "./lifecycle-policy.ts";
import { outboundFromEnvEntries, OUTBOUND_ENV_KEYS } from "./outbound-config.ts";

test("restart extraction preserves every supported outbound policy key and rejects lookalikes", () => {
  const env = OUTBOUND_ENV_KEYS.map((key, i) => `${key}=value-${i}`);
  env.push("AGENT_WECHAT_NOT_A_POLICY=secret");
  const extracted = outboundFromEnvEntries(env);
  assert.deepEqual(extracted, Object.fromEntries(OUTBOUND_ENV_KEYS.map((key, i) => [key, `value-${i}`])));
});

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

test("lifecycle volumes require local driver, instance label, and matching role", () => {
  const owned = { Name: "agent-wechat-data", Driver: "local", Labels: { "dev.visionclaw.agent-wechat.instance": "default", "dev.visionclaw.agent-wechat.volume-role": "data" } };
  assert.equal(hasOwnedVolume(owned, "agent-wechat-data", "data"), true);
  assert.equal(hasOwnedVolume({ ...owned, Labels: {} }, "agent-wechat-data", "data"), false);
  assert.equal(hasOwnedVolume({ ...owned, Driver: "custom" }, "agent-wechat-data", "data"), false);
  assert.equal(hasOwnedVolume(owned, "agent-wechat-data", "wechat-home"), false);
});
