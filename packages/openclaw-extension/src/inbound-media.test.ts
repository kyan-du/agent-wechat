import assert from "node:assert/strict";
import test from "node:test";
import { safeBodyAfterKnownMediaFailure, validateInboundMedia } from "./inbound-media.ts";

const FIXTURES: Record<string, Buffer> = {
  jpeg: Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ar//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64",
  ),
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    "base64",
  ),
  webp: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
  gif: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
};

const media = (format: string, bytes: Buffer | number[]) => ({
  type: "image" as const,
  data: Buffer.from(bytes).toString("base64"),
  format,
  filename: "fixture",
});

test("accepts real minimal JPEG, PNG, WebP, and GIF images with matching MIME", () => {
  assert.equal(validateInboundMedia(media("jpeg", FIXTURES.jpeg)).ok, true);
  assert.equal(validateInboundMedia(media("png", FIXTURES.png)).ok, true);
  assert.equal(validateInboundMedia(media("gif", FIXTURES.gif)).ok, true);
  const webp = validateInboundMedia(media("webp", FIXTURES.webp));
  assert.deepEqual(webp.ok && webp.value.mime, "image/webp");
});

test("rejects empty, malformed, and magic/MIME mismatched image data before saving", () => {
  assert.deepEqual(validateInboundMedia({ type: "image", data: "", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_EMPTY_DATA" });
  assert.deepEqual(validateInboundMedia({ type: "image", data: "%%%", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_INVALID_BASE64" });
  assert.deepEqual(validateInboundMedia(media("png", [0xff,0xd8,0xff,0x00])), { ok: false, code: "MEDIA_MAGIC_MISMATCH" });
});

test("rejects signature-only and truncated image payloads", () => {
  const signatureOnly = {
    jpeg: [0xff, 0xd8, 0xff, 0x00],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    webp: [...Buffer.from("RIFF0000WEBP")],
    gif: [...Buffer.from("GIF89a")],
  };
  for (const [format, bytes] of Object.entries(signatureOnly)) {
    assert.deepEqual(validateInboundMedia(media(format, bytes)), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
  for (const [format, bytes] of Object.entries(FIXTURES)) {
    assert.deepEqual(validateInboundMedia(media(format, bytes.subarray(0, bytes.length - 2))), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
});

test("rejects structurally corrupt image payloads", () => {
  for (const [format, bytes] of Object.entries(FIXTURES)) {
    const corrupted = Buffer.from(bytes);
    if (format === "webp") {
      corrupted[23] ^= 0xff;
    } else {
      corrupted[corrupted.length - 1] ^= 0xff;
    }
    assert.deepEqual(validateInboundMedia(media(format, corrupted)), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
});

test("rejects image payloads above the bounded validation size", () => {
  const hugeJpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20 * 1024 * 1024)]);
  assert.deepEqual(validateInboundMedia(media("jpeg", hugeJpegLike)), { ok: false, code: "MEDIA_IMAGE_TOO_LARGE" });
});

test("known image failure never exposes original XML", () => {
  const xml = '<msg><img aeskey="secret" cdnmidimgurl="secret"/></msg>';
  assert.equal(safeBodyAfterKnownMediaFailure(3, xml), "[Image unavailable]");
  assert.equal(safeBodyAfterKnownMediaFailure(1, "hello"), "hello");
});

test("save helper reports absent path and thrown saves without exposing details", async () => {
  const { saveValidatedInboundMedia } = await import("./inbound-media.ts");
  const fixture = media("jpeg", FIXTURES.jpeg);
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({})), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({ path: "  " })), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => { throw new Error("redacted fixture detail"); }), { ok: false, code: "MEDIA_SAVE_FAILED" });
  assert.deepEqual(await saveValidatedInboundMedia(fixture, async () => ({ path: "/opaque/media" })), { ok: true, path: "/opaque/media", mime: "image/jpeg" });
});
