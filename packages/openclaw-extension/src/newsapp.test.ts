import assert from "node:assert/strict";
import test from "node:test";
import {
  extractNewsappUrls,
  isNewsappChat,
  newsappFallbackMessage,
  shouldBypassNewsappAuthorization,
  shouldSkipNewsappOpen,
} from "./newsapp.ts";

test("recognizes only the newsapp system chat", () => {
  assert.equal(isNewsappChat({ id: "newsapp", username: "newsapp" }), true);
  assert.equal(isNewsappChat({ id: "wxid_newsapp", username: "wxid_newsapp" }), false);
  assert.equal(shouldSkipNewsappOpen({ id: "newsapp", username: "newsapp" }), true);
  assert.equal(shouldBypassNewsappAuthorization({ id: "newsapp", username: "newsapp" }), true);
  assert.equal(shouldBypassNewsappAuthorization({ id: "wxid_other", username: "wxid_other" }), false);
});

test("extracts and de-duplicates URLs from a news preview", () => {
  assert.deepEqual(
    extractNewsappUrls("头条 https://example.com/a，重复 https://example.com/a。"),
    ["https://example.com/a"],
  );
});

test("builds a fallback inbound message when newsapp has no message rows", () => {
  const message = newsappFallbackMessage({
    id: "newsapp",
    username: "newsapp",
    lastMessagePreview: "重要新闻 https://example.com/news",
    lastMsgLocalId: 42,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(message?.localId, 42);
  assert.match(message?.content ?? "", /重要新闻/);
  assert.match(message?.content ?? "", /https:\/\/example\.com\/news/);
});

test("does not synthesize a message without a preview or stable local id", () => {
  assert.equal(newsappFallbackMessage({ id: "newsapp", username: "newsapp" }), null);
  assert.equal(
    newsappFallbackMessage({ id: "newsapp", username: "newsapp", lastMessagePreview: "news" }),
    null,
  );
});
