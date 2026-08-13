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

test("sendParamsSchema stays assignable to generated SendParams", () => {
  type Parsed = ReturnType<typeof sendParamsSchema.parse>;
  const _compat: Assignable<Parsed, GeneratedSendParams> = true;
  assert.equal(_compat, true);
});
