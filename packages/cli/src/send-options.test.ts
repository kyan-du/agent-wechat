import assert from "node:assert/strict";
import test from "node:test";
import { buildCliSendParams } from "./send-options.ts";

test("similarity confirmation is absent by default", () => {
  const params = buildCliSendParams({ chatId: "chat", text: "hello" });
  assert.equal(params.similarityConfirmed, undefined);
  assert.equal(params.source, "cli");
});

test("payloads are exclusive and idempotency is exposed", () => {
  assert.throws(() => buildCliSendParams({ chatId: "chat" }), /exactly one/);
  assert.throws(() => buildCliSendParams({ chatId: "chat", text: "hi", file: { data: "x", filename: "x" } }), /exactly one/);
  assert.equal(
    buildCliSendParams({ chatId: "chat", text: "hi", idempotencyKey: "cli-1" }).idempotencyKey,
    "cli-1",
  );
});

test("similarity confirmation is set only by the explicit CLI flag", () => {
  const params = buildCliSendParams({
    chatId: "chat",
    text: "reviewed template",
    confirmSimilar: true,
  });
  assert.equal(params.similarityConfirmed, true);
});

test("CLI trims valid fields and rejects blank recipients or text", () => {
  assert.deepEqual(
    buildCliSendParams({ chatId: " chat ", text: " hello " }),
    { chatId: "chat", text: "hello", source: "cli" },
  );
  assert.throws(() => buildCliSendParams({ chatId: " ", text: "hello" }), /chatId/);
  assert.throws(() => buildCliSendParams({ chatId: "chat", text: " \n " }), /text/);
});
