import assert from "node:assert/strict";
import test from "node:test";
import { hasOwnedContainer, hasOwnedVolume } from "./lifecycle-policy.ts";

test("fixed-name containers require the CLI instance label", () => {
  const owned = { Id: "a".repeat(64), Image: "sha256:x", Config: { Labels: { "dev.visionclaw.agent-wechat.instance": "default" } } };
  assert.equal(hasOwnedContainer(owned), true);
  assert.equal(hasOwnedContainer({ ...owned, Config: { Labels: {} } }), false);
  assert.equal(hasOwnedContainer({ ...owned, Config: {} }), false);
});

test("purge volumes require local driver, instance label, and matching role", () => {
  const owned = { Driver: "local", Labels: { "dev.visionclaw.agent-wechat.instance": "default", "dev.visionclaw.agent-wechat.volume-role": "data" } };
  assert.equal(hasOwnedVolume(owned, "data"), true);
  assert.equal(hasOwnedVolume({ ...owned, Labels: {} }, "data"), false);
  assert.equal(hasOwnedVolume({ ...owned, Driver: "custom" }, "data"), false);
  assert.equal(hasOwnedVolume(owned, "wechat-home"), false);
});
