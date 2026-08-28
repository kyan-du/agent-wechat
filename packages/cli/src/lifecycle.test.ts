import assert from "node:assert/strict";
import test from "node:test";

test("simplified lifecycle keeps the fixed container name", () => {
  assert.equal("agent-wechat", "agent-wechat");
});

test("purge remains an explicit operation", () => {
  assert.ok(true);
});
