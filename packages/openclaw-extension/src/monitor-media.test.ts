import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS,
  IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS,
  createImageMaterializationTrigger,
  createMediaMaterializationTrigger,
  imageMaterializationTriggerForMessage,
  mediaFlagsFromPollResult,
  mediaMaterializationTriggerForMessage,
  nestedChatHistoryMedia,
  pollMedia,
  shouldPollInboundMedia,
} from "./inbound-media-poll.ts";
import { formatType49MediaFailureBody, safeBodyAfterKnownMediaFailure } from "./inbound-media.ts";
import fs from "node:fs";
import path from "node:path";

test("inbound downloaded media populates singular and plural runtime fields", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "monitor.ts"), "utf8");
  assert.match(source, /mediaMaterializationTriggerForMessage\(\{[\s\S]*skipOpen,/);
  assert.match(source, /prepareMessage\([\s\S]*skipOpen\)/);
  assert.match(source, /MediaPath:\s*mediaPath/);
  assert.match(source, /MediaUrl:\s*mediaPath/);
  assert.match(source, /MediaType:\s*mediaMime/);
  assert.match(source, /MediaPaths:\s*mediaPaths/);
  assert.match(source, /MediaUrls:\s*mediaPaths/);
  assert.match(source, /MediaTypes:\s*mediaMimes/);
  assert.match(source, /shouldPollInboundMedia\(msg\)/);
  assert.match(source, /nestedChatHistoryMedia\(result\)/);
  assert.match(source, /mediaFlagsFromPollResult\(result, baseType\)/);
});

function inboundType49Body(
  msg: { type: number; content?: string; forwarded?: unknown },
  pollResult?: { type?: string; data?: string; errorCode?: string; items?: Array<{ type?: string; data?: string; format?: string; filename?: string }> } | null,
): { rawBody: string; hasMedia: boolean; mediaErrorCode?: string; polled: boolean } {
  const baseType = msg.type & 0x7fffffff;
  const polled = shouldPollInboundMedia(msg);
  const flags = polled ? mediaFlagsFromPollResult(pollResult, baseType) : { hasMedia: false as const };
  let rawBody = safeBodyAfterKnownMediaFailure(baseType, msg.content || "");
  if (flags.mediaErrorCode && baseType === 49 && !msg.content?.startsWith("[Chat History]") && !msg.forwarded) {
    rawBody = formatType49MediaFailureBody(msg.content || "", flags.mediaErrorCode);
  }
  return { rawBody, polled, hasMedia: flags.hasMedia, mediaErrorCode: flags.mediaErrorCode };
}

test("chat history keeps text, polls nested items, and does not append MEDIA_UNSUPPORTED", () => {
  const title = "姐姐狐的聊天记录";
  const cases = [
    {
      type: 49,
      content: `[Chat History] ${title}`,
      forwarded: { schemaVersion: 1, title, nodes: [], truncated: false },
    },
    { type: 49, content: `[Chat History] ${title}` },
    { type: 49, content: `<msg><appmsg><title>${title}</title><type>19</type></appmsg></msg>` },
    { type: (19 * 0x1_0000_0000) + 49, content: title },
  ];
  for (const msg of cases) {
    assert.equal(shouldPollInboundMedia(msg), true, JSON.stringify(msg));
    const inbound = inboundType49Body(msg, {
      type: "unsupported",
      errorCode: "MEDIA_UNSUPPORTED",
    });
    assert.equal(inbound.polled, true);
    assert.equal(inbound.hasMedia, false);
    assert.equal(inbound.mediaErrorCode, undefined);
    assert.equal(inbound.rawBody.includes("MEDIA_UNSUPPORTED"), false);
    assert.equal(inbound.rawBody.includes("Attachment unavailable"), false);
    assert.match(inbound.rawBody, new RegExp(title));
  }
});

test("chat history nested items attach as inbound media without attachment failure", () => {
  const result = {
    type: "unsupported" as const,
    items: [
      { type: "image", data: "/9j/AA==", format: "jpeg", filename: "a.jpg" },
      { type: "file", data: "JVBERi0x", format: "pdf", filename: "b.pdf" },
      { type: "unsupported", format: "", filename: "" },
    ],
  };
  assert.deepEqual(mediaFlagsFromPollResult(result, 49), { hasMedia: true });
  assert.equal(nestedChatHistoryMedia(result).length, 2);
  const inbound = inboundType49Body(
    { type: 49, content: "[Chat History] 姐姐狐的聊天记录" },
    result,
  );
  assert.equal(inbound.polled, true);
  assert.equal(inbound.hasMedia, true);
  assert.equal(inbound.mediaErrorCode, undefined);
  assert.equal(inbound.rawBody, "[Chat History] 姐姐狐的聊天记录");
});

test("unsupported poll results do not mark type 49 as a failed attachment", () => {
  const flags = mediaFlagsFromPollResult({
    type: "unsupported",
    errorCode: "MEDIA_UNSUPPORTED",
  }, 49);
  assert.deepEqual(flags, { hasMedia: false });
  const inbound = inboundType49Body(
    { type: 49, content: "[Chat History] 姐姐狐的聊天记录" },
    { type: "unsupported", errorCode: "MEDIA_UNSUPPORTED" },
  );
  assert.equal(inbound.rawBody, "[Chat History] 姐姐狐的聊天记录");
});

test("type 49 subtype 6 files still poll and keep attachment failures", () => {
  const fileMsg = { type: 49, content: "report.pdf" };
  assert.equal(shouldPollInboundMedia(fileMsg), true);
  const pending = mediaFlagsFromPollResult({
    type: "file",
    errorCode: "FILE_NOT_DOWNLOADED",
  }, 49);
  assert.equal(pending.hasMedia, true);
  assert.equal(pending.mediaErrorCode, "FILE_NOT_DOWNLOADED");
  const inbound = inboundType49Body(fileMsg, {
    type: "file",
    errorCode: "FILE_NOT_DOWNLOADED",
  });
  assert.equal(inbound.polled, true);
  assert.equal(inbound.rawBody, "report.pdf\n[Attachment unavailable: FILE_NOT_DOWNLOADED]");
});

test("type 3 images still poll", () => {
  assert.equal(shouldPollInboundMedia({ type: 3, content: "" }), true);
  const flags = mediaFlagsFromPollResult({
    type: "image",
    data: "/9j/AA==",
  }, 3);
  assert.deepEqual(flags, { hasMedia: true });
  const missing = mediaFlagsFromPollResult({
    type: "pending",
    errorCode: "IMAGE_RESOURCE_UNAVAILABLE",
  }, 3);
  assert.equal(missing.hasMedia, true);
  assert.equal(missing.mediaErrorCode, "IMAGE_RESOURCE_UNAVAILABLE");
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
      client: { openChat: async () => { throw new Error("voice must not openChat"); } },
      chatId: "vangie",
      messageType: 34,
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

test("media polling triggers downloadFile once for group FILE_NOT_DOWNLOADED", async () => {
  let calls = 0;
  let opens = 0;
  let downloads = 0;
  const trigger = mediaMaterializationTriggerForMessage({
    client: {
      openChat: async () => { opens += 1; },
      downloadFile: async (chatId, filename) => {
        assert.equal(chatId, "34438530917@chatroom");
        assert.equal(filename, "小队参观路线.docx");
        downloads += 1;
      },
    },
    chatId: "34438530917@chatroom",
    messageType: 49,
    skipOpen: true,
  });
  assert.ok(trigger);
  const result = await pollMedia({
    getMedia: async () => {
      calls += 1;
      return calls < 3
        ? { type: "file", format: "docx", filename: "小队参观路线.docx", errorCode: "FILE_NOT_DOWNLOADED" }
        : { type: "file", data: "UEsDBA==", format: "docx", filename: "小队参观路线.docx" };
    },
  } as never, "34438530917@chatroom", 88, undefined, 3, 0, trigger);
  assert.equal(calls, 3);
  assert.equal(opens, 0);
  assert.equal(downloads, 1);
  assert.equal(result?.type, "file");
  assert.equal(result?.data, "UEsDBA==");
});

test("FILE_NOT_STABLE still uses the bounded file bubble click trigger", async () => {
  let opens = 0;
  let downloads = 0;
  const trigger = createMediaMaterializationTrigger({
    openChat: async () => { opens += 1; },
    downloadFile: async (_chatId, filename) => {
      assert.equal(filename, "report.pdf");
      downloads += 1;
    },
  }, "wxid_direct");
  const result = await pollMedia({
    getMedia: async () => ({ type: "file", format: "pdf", filename: "report.pdf", errorCode: "FILE_NOT_STABLE" }),
  } as never, "wxid_direct", 9, undefined, 2, 0, trigger);
  assert.equal(opens, 0);
  assert.equal(downloads, 1);
  assert.equal(result?.errorCode, "FILE_NOT_STABLE");
});

test("non-file type=49 does not fire openChat because getMedia is unsupported", async () => {
  let opens = 0;
  const trigger = mediaMaterializationTriggerForMessage({
    client: {
      openChat: async () => { opens += 1; },
    },
    chatId: "wxid_direct",
    messageType: 49,
  });
  assert.ok(trigger);
  const result = await pollMedia({
    getMedia: async () => ({ type: "unsupported", format: "", filename: "" }),
  } as never, "wxid_direct", 10, undefined, 3, 0, trigger);
  assert.equal(opens, 0);
  assert.equal(result?.type, "unsupported");
});

test("slow file bubble click does not consume the short media poll window or abort the GUI plan", async () => {
  let opens = 0;
  let downloads = 0;
  let getMediaCalls = 0;
  const startedAt = Date.now();
  const trigger = mediaMaterializationTriggerForMessage({
    client: {
      openChat: async () => { opens += 1; },
      downloadFile: (chatId, filename, signal) => {
        assert.equal(chatId, "34438530917@chatroom");
        assert.equal(filename, "route.docx");
        assert.equal(signal, undefined);
        downloads += 1;
        return new Promise(() => {});
      },
    },
    chatId: "34438530917@chatroom",
    messageType: 49,
    timeoutMs: 20,
  });
  const result = await pollMedia({
    getMedia: async () => {
      getMediaCalls += 1;
      return { type: "file", format: "docx", filename: "route.docx", errorCode: "FILE_NOT_DOWNLOADED" };
    },
  } as never, "34438530917@chatroom", 88, undefined, 2, 0, trigger);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(opens, 0);
  assert.equal(downloads, 1);
  assert.equal(getMediaCalls, 2);
  assert.ok(elapsedMs < 1000, `pollMedia stalled on file bubble click for ${elapsedMs}ms`);
  assert.equal(result?.errorCode, "FILE_NOT_DOWNLOADED");
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
  assert.equal(FILE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS, IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS);
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
