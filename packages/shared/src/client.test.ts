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

test("syncChat exposes server validation codes before success-schema parsing", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 1, errorCode: "INVALID_LIMIT", items: [], nextCursor: null }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(
      () => client.syncChat("chat", { limit: 0 }),
      (error: unknown) => error instanceof WeChatHttpError && error.errorCode === "INVALID_LIMIT",
    );
  });
});

test("syncChat rejects malformed pages instead of exposing partial sync state", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 1, items: [], syncToken: "bad", media: [] }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(() => client.syncChat("chat"));
  });
});

test("syncChat preserves the returned cursor for a subsequent page", async () => {
  let seen = "";
  await withServer((request, response) => {
    seen = request.url ?? "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      chat: { id: "chat", username: "chat", name: "Chat", unreadCount: 0, isGroup: false },
      items: [], nextCursor: "page-2", syncToken: "sync-1", media: [],
      readState: { unreadCount: 0, observedAt: "2026-01-01T00:00:00Z" },
    }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    const page = await client.syncChat("chat");
    assert.equal(page.nextCursor, "page-2");
    await client.syncChat("chat", { cursor: page.nextCursor });
    assert.equal(seen, "/api/sync/chat?cursor=page-2");
  });
});

test("syncChat encodes chat, time range, and opaque token", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/sync/room%40chatroom?limit=2&since=token%2B1&from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      chat: { id: "room@chatroom", username: "room@chatroom", name: "Room", unreadCount: 2, isGroup: true },
      items: [], nextCursor: null, syncToken: "next", media: [],
      readState: { unreadCount: 2, observedAt: "2026-01-01T00:00:00Z" },
    }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    const page = await client.syncChat("room@chatroom", { limit: 2, since: "token+1", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
    assert.equal(page.syncToken, "next");
    assert.equal(page.readState.unreadCount, 2);
  });
});

test("listGroupMembersPage encodes a stable group id and preserves pagination", async () => {
  await withServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/groups/room%40chatroom/members?limit=2&cursor=next_page");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      items: [{ memberId: "wxid_a", displayName: "群昵称😀", groupAlias: "群昵称😀" }],
      nextCursor: "after",
    }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    const page = await client.listGroupMembersPage("room@chatroom", 2, "next_page");
    assert.equal(page.items[0]?.memberId, "wxid_a");
    assert.equal(page.items[0]?.displayName, "群昵称😀");
    assert.equal(page.nextCursor, "after");
  });
});

test("listGroupMembersPage exposes explicit API errors", async () => {
  await withServer((_request, response) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ errorCode: "NOT_GROUP_CHAT" }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(
      () => client.listGroupMembersPage("wxid_friend"),
      (error: unknown) => error instanceof WeChatHttpError && error.errorCode === "NOT_GROUP_CHAT",
    );
  });
});

test("listGroupMembersPage rejects malformed successful payloads", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schemaVersion: 1, items: [{ memberId: 7, displayName: "invalid" }], nextCursor: null }));
  }, async (baseUrl) => {
    const client = new WeChatClient({ baseUrl });
    await assert.rejects(() => client.listGroupMembersPage("room@chatroom"));
  });
});

test("openChat forwards AbortSignal so a timed-out GUI request can be cancelled", async () => {
  const original = globalThis.fetch;
  let receivedSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;
  try {
    const client = new WeChatClient({ baseUrl: "http://agent-wechat.local" });
    const controller = new AbortController();
    const pending = client.openChat("wxid_slow", true, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, /aborted|AbortError|fetch failed/i);
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = original;
  }
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
