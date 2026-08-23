import type { MediaResult } from "@kyan-du/agent-wechat-shared";
import sharp from "sharp";
import type { SharpOptions } from "sharp";

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
const MAX_DECODED_IMAGE_BYTES = MAX_IMAGE_PIXELS * 4;
const MAX_GIF_FRAMES = 64;
const GIF_MAX_DICTIONARY_SIZE = 4096;
const MAX_GIF_LZW_OPERATIONS = 10_000_000;
const IMAGE_DECODE_TIMEOUT_SECONDS = 5;
const SHARP_INPUT_OPTIONS: SharpOptions = {
  failOn: "warning",
  limitInputPixels: MAX_IMAGE_PIXELS,
  limitInputChannels: 5,
  sequentialRead: true,
  unlimited: false,
  page: 0,
  pages: 1,
  animated: false,
};

sharp.cache({ files: 0, items: 0, memory: 32 });
sharp.concurrency(1);

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

const SHARP_FORMAT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function skipGifSubBlocks(buffer: Buffer, startOffset: number): number | undefined {
  let offset = startOffset;
  while (offset < buffer.length) {
    const size = buffer[offset++];
    if (size === 0) return offset;
    if (offset + size > buffer.length) return undefined;
    offset += size;
  }
  return undefined;
}

class GifCodeReader {
  private offset: number;
  private blockRemaining = 0;
  private datum = 0;
  private bits = 0;
  private ended = false;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer, startOffset: number) {
    this.buffer = buffer;
    this.offset = startOffset;
  }

  private nextByte(): number | undefined {
    if (this.ended) return undefined;
    if (this.blockRemaining === 0) {
      if (this.offset >= this.buffer.length) return undefined;
      this.blockRemaining = this.buffer[this.offset++];
      if (this.blockRemaining === 0) {
        this.ended = true;
        return undefined;
      }
      if (this.offset + this.blockRemaining > this.buffer.length) return undefined;
    }
    this.blockRemaining -= 1;
    return this.buffer[this.offset++];
  }

  read(codeSize: number): number | undefined {
    while (this.bits < codeSize) {
      const byte = this.nextByte();
      if (byte === undefined) return undefined;
      this.datum |= byte << this.bits;
      this.bits += 8;
    }
    const code = this.datum & ((1 << codeSize) - 1);
    this.datum >>>= codeSize;
    this.bits -= codeSize;
    return code;
  }

  finishSubBlocks(): number | undefined {
    if (this.ended) return this.offset;
    this.offset += this.blockRemaining;
    this.blockRemaining = 0;
    return skipGifSubBlocks(this.buffer, this.offset);
  }
}

// Count decoded GIF pixels without allocating an attacker-sized output array.
// Acceptance requires an explicit EOI code after exactly the declared pixels.
function decodeExactGifLzwPixels(
  buffer: Buffer,
  startOffset: number,
  minCodeSize: number,
  pixelCount: number,
  colorCount: number,
): number | undefined {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) return undefined;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Uint16Array(GIF_MAX_DICTIONARY_SIZE);
  const suffix = new Uint8Array(GIF_MAX_DICTIONARY_SIZE);
  const stack = new Uint8Array(GIF_MAX_DICTIONARY_SIZE + 1);
  for (let code = 0; code < clearCode; code += 1) suffix[code] = code;

  const reader = new GifCodeReader(buffer, startOffset);
  let codeSize = minCodeSize + 1;
  let available = clearCode + 2;
  let oldCode = -1;
  let first = 0;
  let produced = 0;
  let sawInitialClear = false;
  let operations = 0;

  while (produced <= pixelCount && operations < MAX_GIF_LZW_OPERATIONS) {
    operations += 1;
    const next = reader.read(codeSize);
    if (next === undefined) return undefined;
    if (!sawInitialClear) {
      if (next !== clearCode) return undefined;
      sawInitialClear = true;
      continue;
    }
    if (next === clearCode) {
      codeSize = minCodeSize + 1;
      available = clearCode + 2;
      oldCode = -1;
      continue;
    }
    if (next === endCode) {
      return produced === pixelCount ? reader.finishSubBlocks() : undefined;
    }
    if (next > available || next >= GIF_MAX_DICTIONARY_SIZE) return undefined;

    if (oldCode === -1) {
      if (next >= clearCode || next >= colorCount) return undefined;
      produced += 1;
      oldCode = next;
      first = next;
      continue;
    }

    const inCode = next;
    let code = next;
    let top = 0;
    if (code === available) {
      stack[top++] = first;
      code = oldCode;
    } else if (code > available) {
      return undefined;
    }

    let links = 0;
    while (code >= clearCode + 2) {
      operations += 1;
      if (
        operations >= MAX_GIF_LZW_OPERATIONS
        || code >= available
        || top >= stack.length
        || links++ >= GIF_MAX_DICTIONARY_SIZE
      ) return undefined;
      const value = suffix[code];
      if (value >= colorCount) return undefined;
      stack[top++] = value;
      code = prefix[code];
    }
    if (code >= clearCode || code >= colorCount || top >= stack.length) return undefined;
    first = suffix[code];
    stack[top++] = first;
    produced += top;
    if (produced > pixelCount) return undefined;

    if (available < GIF_MAX_DICTIONARY_SIZE) {
      prefix[available] = oldCode;
      suffix[available] = first;
      available += 1;
      if (available === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    oldCode = inCode;
  }
  return undefined;
}

function validateGifLzwStreams(buffer: Buffer): boolean {
  if (buffer.length < 14) return false;
  const canvasWidth = buffer.readUInt16LE(6);
  const canvasHeight = buffer.readUInt16LE(8);
  if (!validDimensions(canvasWidth, canvasHeight)) return false;

  const logicalPacked = buffer[10];
  const globalColorCount = (logicalPacked & 0x80) !== 0
    ? 1 << ((logicalPacked & 0x07) + 1)
    : 0;
  let offset = 13 + globalColorCount * 3;
  if (offset > buffer.length) return false;
  let frameCount = 0;

  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) return frameCount > 0 && offset === buffer.length;
    if (marker === 0x21) {
      if (offset >= buffer.length) return false;
      offset += 1; // Extension label.
      const nextOffset = skipGifSubBlocks(buffer, offset);
      if (nextOffset === undefined) return false;
      offset = nextOffset;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > buffer.length) return false;

    const left = buffer.readUInt16LE(offset);
    const top = buffer.readUInt16LE(offset + 2);
    const width = buffer.readUInt16LE(offset + 4);
    const height = buffer.readUInt16LE(offset + 6);
    const packed = buffer[offset + 8];
    offset += 9;
    if (!validDimensions(width, height)) return false;
    if (left + width > canvasWidth || top + height > canvasHeight) return false;
    frameCount += 1;
    if (frameCount > MAX_GIF_FRAMES) return false;

    const localColorCount = (packed & 0x80) !== 0
      ? 1 << ((packed & 0x07) + 1)
      : 0;
    if (localColorCount > 0) {
      offset += localColorCount * 3;
      if (offset > buffer.length) return false;
    }
    const colorCount = localColorCount || globalColorCount;
    if (colorCount === 0 || offset >= buffer.length) return false;

    const minCodeSize = buffer[offset++];
    const nextOffset = decodeExactGifLzwPixels(
      buffer,
      offset,
      minCodeSize,
      width * height,
      colorCount,
    );
    if (nextOffset === undefined) return false;
    offset = nextOffset;
  }
  return false;
}

async function validateDecodedImage(buffer: Buffer, mime: string): Promise<InboundMediaFailureCode | undefined> {
  if (buffer.length > MAX_IMAGE_BYTES) return "MEDIA_IMAGE_TOO_LARGE";
  if (mime === "image/gif" && !validateGifLzwStreams(buffer)) return "MEDIA_IMAGE_INVALID";
  try {
    const metadata = await sharp(buffer, SHARP_INPUT_OPTIONS)
      .timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
      .metadata();
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    if (metadata.format !== SHARP_FORMAT_BY_MIME[mime]) return "MEDIA_IMAGE_INVALID";
    if (!validDimensions(width, height)) return "MEDIA_IMAGE_TOO_LARGE";

    const decoded = await sharp(buffer, SHARP_INPUT_OPTIONS)
      .timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const decodedBytes = decoded.data.length;
    if (!validDimensions(decoded.info.width, decoded.info.height)) return "MEDIA_IMAGE_TOO_LARGE";
    if (decodedBytes !== decoded.info.width * decoded.info.height * decoded.info.channels) return "MEDIA_IMAGE_INVALID";
    if (decodedBytes > MAX_DECODED_IMAGE_BYTES) return "MEDIA_IMAGE_TOO_LARGE";
    return undefined;
  } catch {
    return "MEDIA_IMAGE_INVALID";
  }
}

export async function validateInboundMedia(result: MediaResult): Promise<InboundMediaValidation> {
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
    const invalidCode = await validateDecodedImage(buffer, detected);
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
  const validated = await validateInboundMedia(result);
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
