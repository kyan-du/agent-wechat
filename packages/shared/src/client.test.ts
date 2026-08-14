import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./schemas/index.js" && context.parentURL?.endsWith("/src/client.ts")) {
      return nextResolve("./schemas/index.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { WeChatClient, WeChatHttpError } = await import("./client.ts");

async function withServer(
  handler: Parameters<typeof createServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("sendMessage decodes recoverable similar-content HTTP 409 without retrying", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/messages/send");
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: false,
      errorCode: "SIMILAR_CONTENT_CONFIRMATION_REQUIRED",
      error: "Explicit operator confirmation is required",
      commitAttempted: false,
    }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    const result = await client.sendMessage({ chatId: "chat", text: "reviewed" });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "SIMILAR_CONTENT_CONFIRMATION_REQUIRED");
  });
  assert.equal(requests, 1, "the shared client must never auto-retry a 409");
});

test("sendMessage rejects blank fields before making an HTTP request", async () => {
  let requests = 0;
  await withServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, commitAttempted: true }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(client.sendMessage({ chatId: " ", text: "hello" }));
    await assert.rejects(client.sendMessage({ chatId: "chat", text: "\n" }));
  });
  assert.equal(requests, 0);
});

test("sendMessage still throws for unrelated HTTP failures", async () => {
  await withServer((_request, response) => {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      success: false,
      errorCode: "UNRELATED_CONFLICT",
      error: "conflict",
      commitAttempted: false,
    }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(
      client.sendMessage({ chatId: "chat", text: "hello" }),
      /409 Conflict/,
    );
  });
});

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
