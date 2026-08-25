import assert from "node:assert/strict";
import test from "node:test";
import { compareMessageCursor, messageEnvelopes, messageIdentityKey, messageCursor } from "./message-domain.ts";

test("message identity remains stable for cursor and ledger projections", () => {
  const message = { serverId: 7, timestamp: "2026-01-01T00:00:00Z", type: 1, sender: "wxid_a", content: "hello" };
  assert.equal(messageIdentityKey(message), "7:2026-01-01T00:00:00Z:1:wxid_a:hello");
  assert.deepEqual(messageCursor({ ...message, localId: 9 }), { timestamp: message.timestamp, localId: 9 });
});

test("message cursor comparison is deterministic", () => {
  assert.equal(compareMessageCursor(
    { timestamp: "2026-01-01T00:00:00Z", localId: 1 },
    { timestamp: "2026-01-01T00:00:00Z", localId: 2 },
  ), -1);
  assert.equal(compareMessageCursor(
    { timestamp: "2026-01-02T00:00:00Z", localId: 1 },
    { timestamp: "2026-01-01T00:00:00Z", localId: 99 },
  ) > 0, true);
});

test("message envelopes attach only media belonging to each local ID", () => {
  const page = {
    items: [
      { localId: 1, serverId: 1, chatId: "chat", type: 3, content: "", timestamp: "2026-01-01T00:00:00Z" },
      { localId: 2, serverId: 2, chatId: "chat", type: 1, content: "text", timestamp: "2026-01-01T00:00:01Z" },
    ],
    media: [{ localId: 1, url: "/api/messages/chat/media/1" }],
  };
  const envelopes = messageEnvelopes(page);
  assert.equal(envelopes.length, 2);
  assert.deepEqual(envelopes[0]?.media, page.media);
  assert.deepEqual(envelopes[1]?.media, []);
});
