import type { MediaResult } from "@kyan-du/agent-wechat-shared";

export type InboundMediaFailureCode =
  | "MEDIA_EMPTY_DATA"
  | "MEDIA_INVALID_BASE64"
  | "MEDIA_MAGIC_MISMATCH"
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

function imageMimeFromMagic(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  return undefined;
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
