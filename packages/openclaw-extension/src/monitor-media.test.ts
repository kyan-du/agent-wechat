import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS,
  createImageMaterializationTrigger,
  imageMaterializationTriggerForMessage,
  pollMedia,
} from "./inbound-media-poll.ts";
import fs from "node:fs";
import path from "node:path";

test("inbound downloaded media populates singular and plural runtime fields", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "monitor.ts"), "utf8");
  assert.match(source, /imageMaterializationTriggerForMessage\(\{[\s\S]*skipOpen,/);
  assert.match(source, /prepareMessage\([\s\S]*skipOpen\)/);
  assert.match(source, /MediaPath:\s*mediaPath/);
  assert.match(source, /MediaUrl:\s*mediaPath/);
  assert.match(source, /MediaType:\s*mediaMime/);
  assert.match(source, /MediaPaths:\s*\[mediaPath\]/);
  assert.match(source, /MediaUrls:\s*\[mediaPath\]/);
  assert.match(source, /MediaTypes:\s*mediaMime \? \[mediaMime\] : \[\]/);
});

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

test("media polling retries FILE_NOT_STABLE until a stable snapshot is available", async () => {
  let calls = 0;
  const client = { getMedia: async () => ++calls < 3
    ? { type: "file", format: "pdf", filename: "report.pdf", errorCode: "FILE_NOT_STABLE" }
    : { type: "file", data: "JVBERi0x", format: "pdf", filename: "report.pdf" }
  };
  const result = await pollMedia(client as never, "redacted", 2, undefined, 3, 0);
  assert.equal(calls, 3);
  assert.equal(result?.data, "JVBERi0x");
});

test("media polling preserves stable terminal diagnostics", async () => {
  const client = { getMedia: async () => ({
    type: "file", format: "pdf", filename: "报告.pdf", errorCode: "FILE_TOO_LARGE",
  }) };
  const result = await pollMedia(client as never, "redacted", 1, undefined, 3, 0);
  assert.equal(result?.errorCode, "FILE_TOO_LARGE");
});

test("media polling retries delayed group-image materialization", async () => {
  let calls = 0;
  const client = { getMedia: async (chatId: string) => {
    assert.equal(chatId, "room@chatroom");
    calls += 1;
    return calls < 3
      ? { type: "image", format: "jpeg", filename: "group.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" }
      : { type: "image", data: "/9j/AA==", format: "jpeg", filename: "group.jpg" };
  } };
  const result = await pollMedia(client as never, "room@chatroom", 42, undefined, 3, 0);
  assert.equal(calls, 3);
  assert.equal(result?.type, "image");
  assert.equal(result?.data, "/9j/AA==");
});

test("media polling retries delayed direct-image and image-file materialization separately", async () => {
  let imageCalls = 0;
  const directImage = { getMedia: async () => {
    imageCalls += 1;
    return imageCalls === 1
      ? { type: "pending", format: "jpeg", filename: "direct.jpg", errorCode: "MEDIA_NOT_DOWNLOADED" }
      : { type: "image", data: "/9j/AA==", format: "jpeg", filename: "direct.jpg" };
  } };
  const image = await pollMedia(directImage as never, "wxid_direct", 7, undefined, 2, 0);
  assert.equal(imageCalls, 2);
  assert.equal(image?.type, "image");

  let fileCalls = 0;
  const delayedFile = { getMedia: async () => {
    fileCalls += 1;
    return fileCalls === 1
      ? { type: "file", format: "pdf", filename: "report.pdf", errorCode: "FILE_NOT_DOWNLOADED" }
      : { type: "file", data: "JVBERi0x", format: "pdf", filename: "report.pdf" };
  } };
  const file = await pollMedia(delayedFile as never, "wxid_direct", 8, undefined, 2, 0);
  assert.equal(fileCalls, 2);
  assert.equal(file?.type, "file");
  assert.equal(file?.data, "JVBERi0x");
});

test("media polling returns the last transient diagnostic after bounded exhaustion", async () => {
  let calls = 0;
  const client = { getMedia: async () => {
    calls += 1;
    return { type: "image", format: "jpeg", filename: "late.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" };
  } };
  const result = await pollMedia(client as never, "room@chatroom", 99, undefined, 2, 0);
  assert.equal(calls, 2);
  assert.equal(result?.errorCode, "IMAGE_RESOURCE_UNAVAILABLE");
});

test("media polling triggers materialization once before bounded retries", async () => {
  let calls = 0;
  let opens = 0;
  const client = { getMedia: async () => {
    calls += 1;
    return calls < 3
      ? { type: "image", format: "jpeg", filename: "late.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" }
      : { type: "image", data: "/9j/AA==", format: "jpeg", filename: "late.jpg" };
  } };
  const trigger = createImageMaterializationTrigger({
    openChat: async (chatId, clearUnreads) => {
      assert.equal(chatId, "wxid_direct");
      assert.equal(clearUnreads, true);
      opens += 1;
    },
  }, "wxid_direct");
  const result = await pollMedia(client as never, "wxid_direct", 101, undefined, 3, 0, trigger);
  assert.equal(calls, 3);
  assert.equal(opens, 1);
  assert.equal(result?.data, "/9j/AA==");
});

test("catch-up skipOpen still runs one-shot image materialization openChat", async () => {
  let opens = 0;
  const trigger = imageMaterializationTriggerForMessage({
    client: {
      openChat: async (chatId, clearUnreads) => {
        assert.equal(chatId, "vangie");
        assert.equal(clearUnreads, true);
        opens += 1;
      },
    },
    chatId: "vangie",
    messageType: 3,
    skipOpen: true,
  });
  assert.ok(trigger);
  assert.equal(
    imageMaterializationTriggerForMessage({
      client: { openChat: async () => { throw new Error("type 49 must not openChat"); } },
      chatId: "vangie",
      messageType: 49,
      skipOpen: true,
    }),
    undefined,
  );
  const media = {
    getMedia: async () => ({ type: "image", format: "jpeg", filename: "late.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" }),
  };
  const result = await pollMedia(media as never, "vangie", 26, undefined, 6, 0, trigger);
  assert.equal(opens, 1);
  assert.equal(result?.errorCode, "IMAGE_RESOURCE_UNAVAILABLE");
});

test("slow openChat does not consume the short media poll window", async () => {
  let opens = 0;
  let getMediaCalls = 0;
  const startedAt = Date.now();
  let aborted = false;
  const trigger = createImageMaterializationTrigger({
    openChat: (chatId, clearUnreads, signal) => {
      assert.equal(chatId, "vangie");
      assert.equal(clearUnreads, true);
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      opens += 1;
      return new Promise(() => {});
    },
  }, "vangie", { timeoutMs: 20 });
  const result = await pollMedia({
    getMedia: async () => {
      getMediaCalls += 1;
      return { type: "image", format: "jpeg", filename: "late.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" };
    },
  } as never, "vangie", 26, undefined, 2, 0, trigger);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(opens, 1);
  assert.equal(getMediaCalls, 2);
  assert.equal(aborted, true, "timed-out openChat must receive cancellation");
  assert.ok(elapsedMs < 1000, `pollMedia stalled on openChat for ${elapsedMs}ms`);
  assert.equal(result?.errorCode, "IMAGE_RESOURCE_UNAVAILABLE");
});

test("openChat UNKNOWN_UI_STATE_TIMEOUT still finishes pollMedia in the short window", async () => {
  let opens = 0;
  let getMediaCalls = 0;
  const startedAt = Date.now();
  const trigger = createImageMaterializationTrigger({
    openChat: async () => {
      opens += 1;
      throw Object.assign(new Error("UNKNOWN_UI_STATE_TIMEOUT"), { code: "UNKNOWN_UI_STATE_TIMEOUT" });
    },
  }, "vangie");
  const result = await pollMedia({
    getMedia: async () => {
      getMediaCalls += 1;
      return { type: "image", format: "jpeg", filename: "late.jpg", errorCode: "IMAGE_RESOURCE_UNAVAILABLE" };
    },
  } as never, "vangie", 26, undefined, 2, 0, trigger);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(opens, 1);
  assert.equal(getMediaCalls, 2);
  assert.ok(elapsedMs < 1000, `pollMedia stalled after openChat throw for ${elapsedMs}ms`);
  assert.equal(result?.errorCode, "IMAGE_RESOURCE_UNAVAILABLE");
});

test("default image openChat timeout stays shorter than the media poll window", () => {
  assert.ok(
    IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS < 6 * 500,
    "openChat timeout must not expand the claimed ~3s media window",
  );
});

test("media polling stops immediately for permanent image key and decryption failures", async () => {
  for (const errorCode of ["IMAGE_XOR_KEY_UNAVAILABLE", "IMAGE_DECRYPTION_FAILED"]) {
    let calls = 0;
    const client = { getMedia: async () => {
      calls += 1;
      return { type: "pending", format: "jpeg", filename: "broken.jpg", errorCode };
    } };
    const result = await pollMedia(client as never, "room@chatroom", 100, undefined, 30, 0);
    assert.equal(calls, 1, errorCode);
    assert.equal(result?.errorCode, errorCode);
    assert.equal(result?.type, "pending");
  }
});
