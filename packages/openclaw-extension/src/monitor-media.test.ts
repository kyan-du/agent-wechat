import assert from "node:assert/strict";
import test from "node:test";
import { pollMedia } from "./inbound-media-poll.ts";

test("media polling transitions from pending to success", async () => {
  let calls = 0;
  const client = { getMedia: async () => ++calls === 1
    ? { type: "pending", format: "", filename: "" }
    : { type: "image", data: "/9j/AA==", format: "jpeg", filename: "fixture.jpg" }
  };
  const result = await pollMedia(client as never, "redacted", 1, undefined, 2, 0);
  assert.equal(calls, 2);
  assert.equal(result?.type, "image");
});

test("media polling preserves stable terminal diagnostics", async () => {
  const client = { getMedia: async () => ({
    type: "file", format: "pdf", filename: "报告.pdf", errorCode: "FILE_TOO_LARGE",
  }) };
  const result = await pollMedia(client as never, "redacted", 1, undefined, 3, 0);
  assert.equal(result?.errorCode, "FILE_TOO_LARGE");
});
