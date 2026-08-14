import assert from "node:assert/strict";
import test from "node:test";
import { WeChatClient, WeChatHttpError } from "./client.ts";

test("sendMessage exposes IDEMPOTENCY_CAPACITY on 429", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: false,
        errorCode: "IDEMPOTENCY_CAPACITY",
        error: "Outbound idempotency capacity is exhausted by protected evidence",
        commitAttempted: false,
      }),
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "2", "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const client = new WeChatClient({ baseUrl: "http://agent-wechat.local" });
    await assert.rejects(
      () =>
        client.sendMessage({
          chatId: "wxid_a",
          text: "hi",
          idempotencyKey: "capacity-key",
        }),
      (error: unknown) => {
        assert.ok(error instanceof WeChatHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.errorCode, "IDEMPOTENCY_CAPACITY");
        assert.equal(error.retryAfter, 2);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
