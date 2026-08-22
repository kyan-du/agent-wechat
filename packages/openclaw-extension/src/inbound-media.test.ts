import assert from "node:assert/strict";
import test from "node:test";
import { safeBodyAfterKnownMediaFailure, validateInboundMedia } from "./inbound-media.ts";

const media = (format: string, bytes: number[]) => ({ type: "image" as const, data: Buffer.from(bytes).toString("base64"), format, filename: "fixture" });

test("accepts JPEG, PNG, and WebP with matching MIME", () => {
  assert.equal(validateInboundMedia(media("jpeg", [0xff, 0xd8, 0xff, 0x00])).ok, true);
  assert.equal(validateInboundMedia(media("png", [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])).ok, true);
  const webp = validateInboundMedia(media("webp", [...Buffer.from("RIFF0000WEBP")]));
  assert.deepEqual(webp.ok && webp.value.mime, "image/webp");
});

test("rejects empty, malformed, and magic/MIME mismatched image data", () => {
  assert.deepEqual(validateInboundMedia({ type: "image", data: "", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_EMPTY_DATA" });
  assert.deepEqual(validateInboundMedia({ type: "image", data: "%%%", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_INVALID_BASE64" });
  assert.deepEqual(validateInboundMedia(media("png", [0xff,0xd8,0xff,0x00])), { ok: false, code: "MEDIA_MAGIC_MISMATCH" });
});

test("known image failure never exposes original XML", () => {
  const xml = '<msg><img aeskey="secret" cdnmidimgurl="secret"/></msg>';
  assert.equal(safeBodyAfterKnownMediaFailure(3, xml), "[Image unavailable]");
  assert.equal(safeBodyAfterKnownMediaFailure(1, "hello"), "hello");
});

test("save helper reports absent path and thrown saves without exposing details", async () => {
  const { saveValidatedInboundMedia } = await import("./inbound-media.ts");
  const fixture = media("jpeg", [0xff, 0xd8, 0xff, 0x00]);
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({})), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({ path: "  " })), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => { throw new Error("redacted fixture detail"); }), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({ path: "/opaque/media" })), { ok: true, path: "/opaque/media", mime: "image/jpeg" });
});
