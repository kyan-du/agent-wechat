import type { MediaResult } from "@kyan-du/agent-wechat-shared";
import { inflateSync } from "node:zlib";

export type InboundMediaFailureCode =
  | "MEDIA_EMPTY_DATA"
  | "MEDIA_INVALID_BASE64"
  | "MEDIA_MAGIC_MISMATCH"
  | "MEDIA_IMAGE_INVALID"
  | "MEDIA_IMAGE_TOO_LARGE"
  | "MEDIA_SAVE_FAILED";

export type ValidatedInboundMedia = { buffer: Buffer; mime: string };
export type InboundMediaValidation =
  | { ok: true; value: ValidatedInboundMedia }
  | { ok: false; code: InboundMediaFailureCode };

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", mp3: "audio/mpeg", pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", txt: "text/plain",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 32_768;
const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;

function imageMimeFromMagic(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  return undefined;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

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

function crc32(buf: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buf: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(signature)) return false;

  let offset = 8;
  let seenIhdr = false;
  let seenIdat = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (dataEnd + 4 > buf.length) return false;

    const type = buf.toString("ascii", typeStart, dataStart);
    const expectedCrc = buf.readUInt32BE(crcOffset);
    if (crc32(buf, typeStart, dataEnd) !== expectedCrc) return false;

    if (!seenIhdr && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (seenIhdr || length !== 13) return false;
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filter = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];
      const validDepthByColor: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!validDimensions(width, height) || compression !== 0 || filter !== 0 || interlace !== 0) return false;
      if (!validDepthByColor[colorType]?.includes(bitDepth)) return false;
      seenIhdr = true;
    } else if (type === "IDAT") {
      if (!seenIhdr || length === 0) return false;
      seenIdat = true;
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !seenIhdr || !seenIdat) return false;
      const channelsByColor: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const rowBytes = Math.ceil((width * channelsByColor[colorType] * bitDepth) / 8) + 1;
      const expectedMinBytes = rowBytes * height;
      try {
        const decoded = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: MAX_PNG_DECODED_BYTES });
        if (decoded.length !== expectedMinBytes) return false;
      } catch {
        return false;
      }
      return crcOffset + 4 === buf.length;
    }
    offset = crcOffset + 4;
  }

  return false;
}

function readJpegMarker(buf: Buffer, offset: number): { marker: number; next: number } | undefined {
  let cursor = offset;
  while (cursor < buf.length && buf[cursor] === 0xff) cursor += 1;
  if (cursor >= buf.length) return undefined;
  return { marker: buf[cursor], next: cursor + 1 };
}

function validateJpeg(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let offset = 2;
  let seenSof = false;
  let seenSos = false;

  while (offset < buf.length) {
    if (buf[offset] !== 0xff) return false;
    const markerInfo = readJpegMarker(buf, offset);
    if (!markerInfo) return false;
    const { marker, next } = markerInfo;
    offset = next;

    if (marker === 0xd9) return seenSof && seenSos && offset === buf.length;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buf.length) return false;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) return false;

    const payloadStart = offset + 2;
    const payloadEnd = offset + segmentLength;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (segmentLength < 8) return false;
      const height = buf.readUInt16BE(payloadStart + 1);
      const width = buf.readUInt16BE(payloadStart + 3);
      if (!validDimensions(width, height)) return false;
      seenSof = true;
    }

    if (marker === 0xda) {
      seenSos = true;
      let scan = payloadEnd;
      let entropyBytes = 0;
      while (scan < buf.length) {
        if (buf[scan] !== 0xff) {
          entropyBytes += 1;
          scan += 1;
          continue;
        }
        while (scan < buf.length && buf[scan] === 0xff) scan += 1;
        if (scan >= buf.length) return false;
        const escapedOrMarker = buf[scan];
        if (escapedOrMarker === 0x00 || (escapedOrMarker >= 0xd0 && escapedOrMarker <= 0xd7)) {
          entropyBytes += 1;
          scan += 1;
          continue;
        }
        if (escapedOrMarker === 0xd9) return seenSof && entropyBytes > 0 && scan + 1 === buf.length;
        offset = scan - 1;
        break;
      }
      if (offset !== scan - 1) return false;
    } else {
      offset = payloadEnd;
    }
  }

  return false;
}

function readUint24Le(buf: Buffer, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function validateWebp(buf: Buffer): boolean {
  if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return false;
  const riffSize = buf.readUInt32LE(4);
  if (riffSize + 8 !== buf.length) return false;

  let offset = 12;
  let seenImage = false;
  while (offset + 8 <= buf.length) {
    const chunkType = buf.toString("ascii", offset, offset + 4);
    const chunkLength = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkLength;
    if (payloadEnd > buf.length) return false;

    if (chunkType === "VP8X") {
      if (chunkLength !== 10) return false;
      const width = readUint24Le(buf, payloadStart + 4) + 1;
      const height = readUint24Le(buf, payloadStart + 7) + 1;
      if (!validDimensions(width, height)) return false;
    } else if (chunkType === "VP8L") {
      if (chunkLength < 5 || buf[payloadStart] !== 0x2f) return false;
      const b1 = buf[payloadStart + 1];
      const b2 = buf[payloadStart + 2];
      const b3 = buf[payloadStart + 3];
      const b4 = buf[payloadStart + 4];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      if (!validDimensions(width, height)) return false;
      seenImage = true;
    } else if (chunkType === "VP8 ") {
      if (chunkLength < 10) return false;
      const frameTag = buf.readUIntLE(payloadStart, 3);
      if ((frameTag & 1) !== 0) return false;
      if (buf[payloadStart + 3] !== 0x9d || buf[payloadStart + 4] !== 0x01 || buf[payloadStart + 5] !== 0x2a) return false;
      const width = buf.readUInt16LE(payloadStart + 6) & 0x3fff;
      const height = buf.readUInt16LE(payloadStart + 8) & 0x3fff;
      if (!validDimensions(width, height)) return false;
      seenImage = true;
    } else if (chunkType === "ALPH" || chunkType === "ICCP" || chunkType === "EXIF" || chunkType === "XMP ") {
      // Ancillary chunks are bounded by the RIFF chunk length checks above.
    } else {
      return false;
    }

    offset = payloadEnd + (chunkLength % 2);
  }

  return seenImage && offset === buf.length;
}

function skipGifSubBlocks(buf: Buffer, offset: number): number | undefined {
  let cursor = offset;
  while (cursor < buf.length) {
    const length = buf[cursor];
    cursor += 1;
    if (length === 0) return cursor;
    if (cursor + length > buf.length) return undefined;
    cursor += length;
  }
  return undefined;
}

function validateGif(buf: Buffer): boolean {
  if (buf.length < 14) return false;
  const header = buf.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return false;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!validDimensions(width, height)) return false;

  let offset = 13;
  const packed = buf[10];
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset >= buf.length) return false;

  let seenImage = false;
  while (offset < buf.length) {
    const blockType = buf[offset];
    offset += 1;
    if (blockType === 0x3b) return seenImage && offset === buf.length;
    if (blockType === 0x21) {
      if (offset >= buf.length) return false;
      offset += 1;
      const next = skipGifSubBlocks(buf, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (blockType !== 0x2c || offset + 9 > buf.length) return false;

    const imageWidth = buf.readUInt16LE(offset + 4);
    const imageHeight = buf.readUInt16LE(offset + 6);
    if (!validDimensions(imageWidth, imageHeight)) return false;
    const imagePacked = buf[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    if (offset >= buf.length) return false;
    offset += 1;
    const next = skipGifSubBlocks(buf, offset);
    if (next === undefined) return false;
    seenImage = true;
    offset = next;
  }

  return false;
}

function validateImageStructure(buffer: Buffer, mime: string): InboundMediaFailureCode | undefined {
  if (buffer.length > MAX_IMAGE_BYTES) return "MEDIA_IMAGE_TOO_LARGE";
  const ok = mime === "image/jpeg"
    ? validateJpeg(buffer)
    : mime === "image/png"
      ? validatePng(buffer)
      : mime === "image/webp"
        ? validateWebp(buffer)
        : mime === "image/gif"
          ? validateGif(buffer)
          : false;
  return ok ? undefined : "MEDIA_IMAGE_INVALID";
}

export function validateInboundMedia(result: MediaResult): InboundMediaValidation {
  if (!result.data) return { ok: false, code: "MEDIA_EMPTY_DATA" };
  const normalized = result.data.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return { ok: false, code: "MEDIA_INVALID_BASE64" };
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) return { ok: false, code: "MEDIA_EMPTY_DATA" };
  const declared = MIME_BY_FORMAT[result.format.toLowerCase()] ?? `application/${result.format || "octet-stream"}`;
  if (result.type === "image") {
    const detected = imageMimeFromMagic(buffer);
    if (!detected || detected !== declared) return { ok: false, code: "MEDIA_MAGIC_MISMATCH" };
    const invalidCode = validateImageStructure(buffer, detected);
    if (invalidCode) return { ok: false, code: invalidCode };
  }
  return { ok: true, value: { buffer, mime: declared } };
}

export function safeBodyAfterKnownMediaFailure(baseType: number, content: string): string {
  return baseType === 3 ? "[Image unavailable]" : content;
}

export async function saveValidatedInboundMedia(
  result: MediaResult,
  save: (buffer: Buffer, mime: string, filename: string) => Promise<{ path?: string } | undefined>,
): Promise<{ ok: true; path: string; mime: string } | { ok: false; code: InboundMediaFailureCode }> {
  const validated = validateInboundMedia(result);
  if (!validated.ok) return validated;
  try {
    const saved = await save(validated.value.buffer, validated.value.mime, result.filename);
    if (!saved?.path || typeof saved.path !== "string" || !saved.path.trim()) {
      return { ok: false, code: "MEDIA_SAVE_FAILED" };
    }
    return { ok: true, path: saved.path, mime: validated.value.mime };
  } catch {
    return { ok: false, code: "MEDIA_SAVE_FAILED" };
  }
}
