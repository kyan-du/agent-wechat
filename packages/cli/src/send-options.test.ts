import assert from "node:assert/strict";
import test from "node:test";
import { buildCliSendParams } from "./send-options.ts";

test("similarity confirmation is absent by default", () => {
  const params = buildCliSendParams({ chatId: "chat", text: "hello" });
  assert.equal(params.similarityConfirmed, undefined);
  assert.equal(params.source, "cli");
});

test("similarity confirmation is set only by the explicit CLI flag", () => {
  const params = buildCliSendParams({
    chatId: "chat",
    text: "reviewed template",
    confirmSimilar: true,
  });
  assert.equal(params.similarityConfirmed, true);
});
