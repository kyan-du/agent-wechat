import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { safeBodyAfterKnownMediaFailure, validateInboundMedia } from "./inbound-media.ts";

const FIXTURES: Record<string, Buffer> = {
  jpeg: Buffer.from(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJgAgj5//9k=",
    "base64",
  ),
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQqTjxH4QZYAwATZwJTT1ZqfsAAAAASUVORK5CYII=",
    "base64",
  ),
  pngAdam7: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAGJxhxeAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRR4yP///0fFsrcAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggXAyk1lgZTMgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yM1QwMzo0MTo1MyswMDowMBHhZUkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjNUMDM6NDE6NTMrMDA6MDBgvN31AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTIzVDAzOjQxOjUzKzAwOjAwN6n8KgAAAAtJREFUCNdjYMAHAAAeAAFuhUcyAAAAAElFTkSuQmCC",
    "base64",
  ),
  webp: Buffer.from("UklGRjoAAABXRUJQVlA4IC4AAAAQAgCdASoCAAIAAUAmJaACdLoB+AH4AAPIAP7udn/+oLQ18vxov/U4MHPn4/wA", "base64"),
  gif: Buffer.from("R0lGODlhAgACAIAAAExpcRR4yCH5BAUAAAAALAAAAAACAAIAAAICjFMAOw==", "base64"),
};

const media = (format: string, bytes: Buffer | number[]) => ({
  type: "image" as const,
  data: Buffer.from(bytes).toString("base64"),
  format,
  filename: "fixture",
});

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function adversarialPngInvalidFilter(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const invalidRgbaRow = Buffer.from([5, 0, 0, 0, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(invalidRgbaRow)),
    pngChunk("IEND"),
  ]);
}

function adversarialJpegNoDecodeTables(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function adversarialWebpEmptyVp8Frame(): Buffer {
  const payload = Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]);
  const out = Buffer.alloc(20 + payload.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + 8 + payload.length, 4);
  out.write("WEBP", 8, "ascii");
  out.write("VP8 ", 12, "ascii");
  out.writeUInt32LE(payload.length, 16);
  payload.copy(out, 20);
  return out;
}

function adversarialGifEmptyLzwData(): Buffer {
  return Buffer.from([
    ...Buffer.from("GIF89a", "ascii"),
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x00,
    0x3b,
  ]);
}

function truncateForDecoder(format: string, bytes: Buffer): Buffer {
  if (format === "jpeg") return bytes.subarray(0, bytes.length - 12);
  if (format === "png") return bytes.subarray(0, bytes.indexOf("IDAT", 0, "ascii") + 10);
  if (format === "webp") return bytes.subarray(0, bytes.length - 12);
  return bytes.subarray(0, bytes.length - 5);
}

function corruptForDecoder(format: string, bytes: Buffer): Buffer {
  const corrupted = Buffer.from(bytes);
  if (format === "png") {
    corrupted[bytes.indexOf("IDAT", 0, "ascii") + 8] ^= 0xff;
  } else if (format === "webp") {
    corrupted[30] ^= 0xff;
  } else if (format === "gif") {
    corrupted[37] = 13;
  } else {
    corrupted[corrupted.length - 8] ^= 0xff;
  }
  return corrupted;
}

test("accepts real minimal JPEG, PNG, WebP, GIF, and Adam7 PNG images with matching MIME", async () => {
  assert.equal((await validateInboundMedia(media("jpeg", FIXTURES.jpeg))).ok, true);
  assert.equal((await validateInboundMedia(media("png", FIXTURES.png))).ok, true);
  assert.equal(FIXTURES.pngAdam7[28], 1);
  assert.equal((await validateInboundMedia(media("png", FIXTURES.pngAdam7))).ok, true);
  assert.equal((await validateInboundMedia(media("gif", FIXTURES.gif))).ok, true);
  const webp = await validateInboundMedia(media("webp", FIXTURES.webp));
  assert.deepEqual(webp.ok && webp.value.mime, "image/webp");
});

test("rejects empty, malformed, and magic/MIME mismatched image data before saving", async () => {
  assert.deepEqual(await validateInboundMedia({ type: "image", data: "", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_EMPTY_DATA" });
  assert.deepEqual(await validateInboundMedia({ type: "image", data: "%%%", format: "jpeg", filename: "x" }), { ok: false, code: "MEDIA_INVALID_BASE64" });
  assert.deepEqual(await validateInboundMedia(media("png", [0xff, 0xd8, 0xff, 0x00])), { ok: false, code: "MEDIA_MAGIC_MISMATCH" });
});

test("rejects signature-only and truncated image payloads", async () => {
  const signatureOnly = {
    jpeg: [0xff, 0xd8, 0xff, 0x00],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    webp: [...Buffer.from("RIFF0000WEBP")],
    gif: [...Buffer.from("GIF89a")],
  };
  for (const [format, bytes] of Object.entries(signatureOnly)) {
    assert.deepEqual(await validateInboundMedia(media(format, bytes)), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
  for (const [format, bytes] of Object.entries({ jpeg: FIXTURES.jpeg, png: FIXTURES.png, webp: FIXTURES.webp, gif: FIXTURES.gif })) {
    assert.deepEqual(await validateInboundMedia(media(format, truncateForDecoder(format, bytes))), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
});

test("rejects corrupt image payloads that a decoder cannot load", async () => {
  for (const [format, bytes] of Object.entries(FIXTURES)) {
    if (format === "pngAdam7") continue;
    const corrupted = corruptForDecoder(format, bytes);
    assert.deepEqual(await validateInboundMedia(media(format, corrupted)), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
});

test("rejects adversarial image containers that are structurally plausible but not decodable", async () => {
  const adversarial = {
    png: adversarialPngInvalidFilter(),
    jpeg: adversarialJpegNoDecodeTables(),
    webp: adversarialWebpEmptyVp8Frame(),
    gif: adversarialGifEmptyLzwData(),
  };
  for (const [format, bytes] of Object.entries(adversarial)) {
    assert.deepEqual(await validateInboundMedia(media(format, bytes)), { ok: false, code: "MEDIA_IMAGE_INVALID" }, format);
  }
});

test("rejects image payloads above the bounded validation size", async () => {
  const hugeJpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20 * 1024 * 1024)]);
  assert.deepEqual(await validateInboundMedia(media("jpeg", hugeJpegLike)), { ok: false, code: "MEDIA_IMAGE_TOO_LARGE" });
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
