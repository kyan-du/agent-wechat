import assert from "node:assert/strict";
import test from "node:test";
import { requireVerifiedChatOpen } from "./monitor-open-chat.ts";

test("HTTP success with a failed selection is rejected", () => {
  assert.throws(
    () => requireVerifiedChatOpen({ ok: false, errorCode: "FRIDA_HOOK_FAILED" }, "target"),
    /FRIDA_HOOK_FAILED/,
  );
});

test("unverified or mismatched selection cannot be reported as opened", () => {
  for (const result of [
    undefined,
    null,
    { ok: true },
    { ok: true, verified: true },
    { ok: true, verified: true, username: "other" },
  ]) {
    assert.throws(
      () => requireVerifiedChatOpen(result, "target"),
      /TARGET_CONFIRMATION_FAILED/,
    );
  }
});

test("exact verified target is accepted", () => {
  assert.doesNotThrow(() =>
    requireVerifiedChatOpen({ ok: true, verified: true, username: "target" }, "target"),
  );
});
