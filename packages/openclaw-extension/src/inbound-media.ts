import type { MediaResult } from "@kyan-du/agent-wechat-shared";
import { decompressFrame, parseGIF } from "gifuct-js";
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

function firstGifImageFrame(parsed: ReturnType<typeof parseGIF>): unknown {
  return parsed.frames.find((frame) => "image" in frame);
}

function validateGifFrameDecode(buffer: Buffer): boolean {
  try {
    const arrayBuffer = Uint8Array.from(buffer).buffer;
    const parsed = parseGIF(arrayBuffer);
    if (!validDimensions(parsed.lsd.width, parsed.lsd.height)) return false;
    const frame = firstGifImageFrame(parsed);
    if (!frame) return false;
    const decoded = decompressFrame(frame as Parameters<typeof decompressFrame>[0], parsed.gct, true);
    if (!validDimensions(decoded.dims.width, decoded.dims.height)) return false;
    if (decoded.patch.length !== decoded.dims.width * decoded.dims.height * 4) return false;
    return decoded.patch.length > 0 && decoded.patch.length <= MAX_DECODED_IMAGE_BYTES;
  } catch {
    return false;
  }
}

async function validateDecodedImage(buffer: Buffer, mime: string): Promise<InboundMediaFailureCode | undefined> {
  if (buffer.length > MAX_IMAGE_BYTES) return "MEDIA_IMAGE_TOO_LARGE";
  if (mime === "image/gif" && !validateGifFrameDecode(buffer)) return "MEDIA_IMAGE_INVALID";
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
