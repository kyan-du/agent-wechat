import assert from "node:assert/strict";
import test from "node:test";
import { waitCompatible, waitHealthy } from "./lifecycle.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("waitHealthy accepts a healthy service response", async () => {
  globalThis.fetch = (async (url: string | URL) => {
    assert.equal(String(url), "http://localhost:6174/health");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  await waitHealthy(100);
});

test("waitCompatible validates the API version after health succeeds", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).endsWith("/health")) return new Response("ok", { status: 200 });
    assert.equal(init?.headers && new Headers(init.headers).get("Authorization"), "Bearer test-token");
    return Response.json({ apiVersion: 1 }, { status: 200 });
  }) as typeof fetch;
  await waitCompatible("test-token", 100);
  assert.deepEqual(urls, ["http://localhost:6174/health", "http://localhost:6174/api/status"]);
});

test("waitCompatible rejects an incompatible API version", async () => {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith("/health")) return new Response("ok", { status: 200 });
    return Response.json({ apiVersion: 2 }, { status: 200 });
  }) as typeof fetch;
  await assert.rejects(() => waitCompatible("test-token", 100), /API version is incompatible/);
});
