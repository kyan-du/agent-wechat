import assert from "node:assert/strict";
import test from "node:test";
import type { LogicalSendParams } from "./outbound.ts";
import { sendLogicalMediaTask } from "./outbound.ts";

test("media and caption share a logical request id and are paced", async () => {
  const sent: LogicalSendParams[] = [];
  const sleeps: number[] = [];
  const requestId = await sendLogicalMediaTask({
    client: {
      async sendMessage(params) {
        sent.push(params);
        return { success: true };
      },
    },
    chatId: "wxid_test",
    media: [{ image: { data: "aW1hZ2U=", mimeType: "image/png" } }],
    caption: "caption",
    requestId: "logical-123",
    interPartDelayMs: 800,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(requestId, "logical-123");
  assert.deepEqual(sleeps, [800]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((part) => part.requestId), [requestId, requestId]);
  assert.deepEqual(sent.map((part) => part.idempotencyKey), ["logical-123:0", "logical-123:1"]);
  assert.deepEqual(sent.map((part) => part.partIndex), [0, 1]);
  assert.deepEqual(sent.map((part) => part.partCount), [2, 2]);
});

test("logical media task stops when a child send fails", async () => {
  let calls = 0;
  await assert.rejects(
    sendLogicalMediaTask({
      client: {
        async sendMessage() {
          calls++;
          return { success: false, error: "blocked" };
        },
      },
      chatId: "wxid_test",
      media: [{ file: { data: "ZmlsZQ==", filename: "test.txt" } }],
      caption: "caption",
      interPartDelayMs: 0,
    }),
    /blocked/,
  );
  assert.equal(calls, 1);
});
