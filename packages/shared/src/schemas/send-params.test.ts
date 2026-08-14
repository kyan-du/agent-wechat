import assert from "node:assert/strict";
import test from "node:test";
import { sendParamsSchema } from "./index.ts";
import type { SendParams as GeneratedSendParams } from "../types/generated/SendParams.ts";

type Assignable<A, B> = A extends B ? true : false;

test("sendParamsSchema preserves inboundChars and idempotencyKey", () => {
  const parsed = sendParamsSchema.parse({
    chatId: "wxid_a",
    text: "hi",
    inboundChars: 12,
    idempotencyKey: "k1",
  });
  assert.equal(parsed.inboundChars, 12);
  assert.equal(parsed.idempotencyKey, "k1");

  const asGenerated: GeneratedSendParams = parsed;
  assert.equal(asGenerated.inboundChars, 12);
});

test("sendParamsSchema preserves validated fairness and confirmation fields", () => {
  const parsed = sendParamsSchema.parse({
    chatId: "wxid_a",
    text: "hello",
    source: "openclaw:primary",
    similarityConfirmed: true,
  });
  assert.equal(parsed.source, "openclaw:primary");
  assert.equal(parsed.similarityConfirmed, true);
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", source: "bad source" }).success,
    false,
  );
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", source: "x".repeat(65) }).success,
    false,
  );
});

test("sendParamsSchema rejects blank chat and text fields", () => {
  for (const chatId of ["", " ", "\t\n"]) {
    assert.equal(sendParamsSchema.safeParse({ chatId, text: "hello" }).success, false);
  }
  for (const text of ["", " ", "\t\n"]) {
    assert.equal(sendParamsSchema.safeParse({ chatId: "wxid_a", text }).success, false);
  }
  const trimmed = sendParamsSchema.parse({ chatId: " wxid_a ", text: " hello " });
  assert.equal(trimmed.chatId, "wxid_a");
  assert.equal(trimmed.text, "hello");
});

test("sendParamsSchema rejects invalid inboundChars", () => {
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", inboundChars: -1 }).success,
    false,
  );
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", inboundChars: 1.5 }).success,
    false,
  );
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", inboundChars: "10" }).success,
    false,
  );
});

test("sendParamsSchema enforces conservative idempotencyKey grammar", () => {
  const boundary = "a".repeat(128);
  assert.equal(
    sendParamsSchema.safeParse({ chatId: "wxid_a", text: "hi", idempotencyKey: boundary }).success,
    true,
  );
  for (const idempotencyKey of [
    "",
    "a".repeat(129),
    "snowman-☃",
    "汉字",
    "line\nbreak",
    "space key",
    "slash/key",
  ]) {
    assert.equal(
      sendParamsSchema.safeParse({ chatId: "wxid_a", text: "hi", idempotencyKey }).success,
      false,
      idempotencyKey,
    );
  }
});

test("sendParamsSchema stays assignable to generated SendParams", () => {
  type Parsed = ReturnType<typeof sendParamsSchema.parse>;
  const _compat: Assignable<Parsed, GeneratedSendParams> = true;
  assert.equal(_compat, true);
});
