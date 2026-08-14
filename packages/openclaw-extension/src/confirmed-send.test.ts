import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenClawConfirmedSend } from "./confirmed-send.ts";

test("OpenClaw confirmation path refuses an ordinary unconfirmed call", () => {
  assert.equal(
    buildOpenClawConfirmedSend({ chatId: "chat", text: "reviewed", confirmed: false }),
    null,
  );
});

test("OpenClaw sets similarity confirmation only after explicit confirmation", () => {
  const params = buildOpenClawConfirmedSend({
    chatId: "chat",
    text: "reviewed",
    confirmed: true,
  });
  assert.equal(params?.similarityConfirmed, true);
  assert.equal(params?.source, "openclaw");
});
