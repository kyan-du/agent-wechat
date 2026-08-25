import type { MediaResult } from "@kyan-du/agent-wechat-shared";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { validateInboundMedia, type InboundMediaFailureCode } from "./inbound-media.ts";

export type MediaStage = "validated" | "deduplicated" | "original_saved" | "preview_generated" | "preview_failed" | "extraction_skipped";
export type MediaPipelineStatus = "processed" | "failed";
export type MediaExtractionStatus = "not_configured" | "not_applicable";

export type MediaBinding = { eventId: string; chatId: string; localId: number; observedAt: number };

export type MediaPipelineRecord = {
  hash: string;
  status: MediaPipelineStatus;
  type: string;
  mime: string;
  originalPath?: string;
  previewPath?: string;
  stages: MediaStage[];
  extraction: MediaExtractionStatus;
  errorCode?: InboundMediaFailureCode | "MEDIA_PREVIEW_FAILED";
  bindings: MediaBinding[];
  createdAt: number;
  updatedAt: number;
};

type PipelineFile = { version: 1; entries: MediaPipelineRecord[] };
export const MAX_MEDIA_PIPELINE_ENTRIES = 5_000;

export type MediaSave = (buffer: Buffer, mime: string, filename: string) => Promise<{ path?: string } | undefined>;
export type MediaRemove = (path: string) => Promise<void>;
export type MediaCleanupOptions = { olderThanMs: number; now?: number; remove?: MediaRemove };
export const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function pipelinePath(accountId: string, stateDir?: string): string {
  const root = stateDir ?? process.env.OPENCLAW_STATE_DIR?.trim() ?? join(homedir(), ".openclaw");
  const safeAccount = accountId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(root, "wechat", `media-pipeline-${safeAccount}.json`);
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncParent(path: string): void { syncFile(dirname(path)); }

function writeState(path: string, file: PipelineFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
  syncFile(temp);
  renameSync(temp, path);
  syncParent(path);
}

function validRecord(value: unknown): value is MediaPipelineRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash) &&
    (row.status === "processed" || row.status === "failed") &&
    typeof row.type === "string" && typeof row.mime === "string" &&
    Array.isArray(row.stages) && row.stages.every((stage) =>
      ["validated", "deduplicated", "original_saved", "preview_generated", "preview_failed", "extraction_skipped"].includes(String(stage))) &&
    Array.isArray(row.bindings) && row.bindings.length <= 1_000 && row.bindings.every((binding) => {
      if (!binding || typeof binding !== "object") return false;
      const item = binding as Record<string, unknown>;
      return typeof item.eventId === "string" && /^[a-f0-9]{64}$/.test(item.eventId) &&
        typeof item.chatId === "string" && item.chatId.length > 0 && item.chatId.length <= 512 &&
        Number.isSafeInteger(item.localId) && typeof item.observedAt === "number" && Number.isFinite(item.observedAt);
    }) &&
    (row.extraction === "not_configured" || row.extraction === "not_applicable") &&
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt);
}

function readState(path: string): PipelineFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_MEDIA_PIPELINE_ENTRIES ||
      !parsed.entries.every(validRecord)) throw new Error("invalid media pipeline state");
    return { version: 1, entries: parsed.entries as MediaPipelineRecord[] };
  } catch (error) {
    throw new Error(`media pipeline state is invalid: ${String(error)}`);
  }
}

function safeFilename(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  const cleaned = [...base].filter((char) => char >= " " && char !== "\u007f").join("").trim();
  return (cleaned || "attachment").slice(0, 180);
}

function previewFilename(filename: string): string {
  const base = safeFilename(filename).replace(/\.[^.]+$/, "");
  return `${base || "attachment"}.preview.jpg`;
}

export type MediaPipelineResult =
  | { ok: true; hash: string; mime: string; originalPath: string; previewPath?: string; record: MediaPipelineRecord }
  | { ok: false; code: InboundMediaFailureCode | "MEDIA_PREVIEW_FAILED" };

export class MediaPipeline {
  private readonly path: string;
  private readonly entries = new Map<string, MediaPipelineRecord>();

  constructor(accountId: string, stateDir?: string) {
    this.path = pipelinePath(accountId, stateDir);
    for (const entry of readState(this.path).entries) this.entries.set(entry.hash, entry);
  }

  private persist(): void {
    const entries = [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (entries.length > MAX_MEDIA_PIPELINE_ENTRIES) entries.splice(MAX_MEDIA_PIPELINE_ENTRIES);
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.hash, entry);
    writeState(this.path, { version: 1, entries });
  }

  private async removePath(removeMedia: MediaRemove | undefined, path: string | undefined): Promise<boolean> {
    if (!removeMedia || !path) return false;
    try {
      await removeMedia(path);
      return true;
    } catch {
      return false;
    }
  }

  private copy(row: MediaPipelineRecord): MediaPipelineRecord {
    return { ...row, stages: [...row.stages], bindings: row.bindings.map((binding) => ({ ...binding })) };
  }

  get(hash: string): MediaPipelineRecord | undefined {
    const row = this.entries.get(hash);
    return row ? this.copy(row) : undefined;
  }

  getByEventId(eventId: string): MediaPipelineRecord | undefined {
    const row = [...this.entries.values()].find((entry) => entry.bindings.some((binding) => binding.eventId === eventId));
    return row ? this.copy(row) : undefined;
  }

  list(): MediaPipelineRecord[] { return [...this.entries.values()].map((row) => this.copy(row)); }

  async cleanup(options: MediaCleanupOptions): Promise<number> {
    const cutoff = (options.now ?? Date.now()) - Math.max(0, options.olderThanMs);
    const expired = [...this.entries.values()].filter((entry) =>
      entry.updatedAt < cutoff && (entry.originalPath !== undefined || entry.previewPath !== undefined));
    let changed = 0;
    for (const entry of expired) {
      const originalRemoved = await this.removePath(options.remove, entry.originalPath);
      const previewRemoved = await this.removePath(options.remove, entry.previewPath);
      if (originalRemoved) entry.originalPath = undefined;
      if (previewRemoved) entry.previewPath = undefined;
      if (originalRemoved || previewRemoved) {
        // Keep the binding ledger after deleting bytes so message provenance remains auditable.
        entry.updatedAt = options.now ?? Date.now();
        changed += 1;
      }
    }
    if (changed > 0) this.persist();
    return changed;
  }

  async process(
    result: MediaResult,
    binding: Omit<MediaBinding, "observedAt">,
    saveOriginal: MediaSave,
    savePreview?: MediaSave,
    removeMedia?: MediaRemove,
    now = Date.now(),
  ): Promise<MediaPipelineResult> {
    const validated = await validateInboundMedia(result);
    if (!validated.ok) return validated;
    const { buffer, mime } = validated.value;
    const hash = createHash("sha256").update(buffer).digest("hex");
    const existing = this.entries.get(hash);
    const observedBinding = { ...binding, observedAt: now };
    if (existing?.status === "processed" && existing.originalPath) {
      if (!existing.bindings.some((item) => item.eventId === binding.eventId)) {
        existing.bindings.push(observedBinding);
        if (existing.bindings.length > 1_000) existing.bindings.shift();
        existing.updatedAt = now;
        this.persist();
      }
      return { ok: true, hash, mime: existing.mime, originalPath: existing.originalPath, previewPath: existing.previewPath, record: this.copy(existing) };
    }

    const record: MediaPipelineRecord = {
      hash, status: "failed", type: result.type, mime, stages: ["validated", "deduplicated"],
      extraction: result.type === "image" || result.type === "file" ? "not_configured" : "not_applicable",
      bindings: [...(existing?.bindings ?? []).filter((item) => item.eventId !== binding.eventId), observedBinding].slice(-1_000),
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    const original = await saveOriginal(buffer, mime, safeFilename(result.filename));
    if (!original?.path?.trim()) {
      record.errorCode = "MEDIA_SAVE_FAILED";
      this.entries.set(hash, record); this.persist();
      return { ok: false, code: "MEDIA_SAVE_FAILED" };
    }
    record.originalPath = original.path;
    record.stages.push("original_saved");

    if (result.type === "image") {
      if (!savePreview) {
        if (await this.removePath(removeMedia, record.originalPath)) record.originalPath = undefined;
        record.errorCode = "MEDIA_PREVIEW_FAILED";
        record.stages.push("preview_failed");
        this.entries.set(hash, record); this.persist();
        return { ok: false, code: "MEDIA_PREVIEW_FAILED" };
      }
      try {
        const preview = await sharp(buffer, { failOn: "warning", limitInputPixels: 40_000_000 })
          .rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82, progressive: true }).toBuffer();
        const savedPreview = await savePreview(preview, "image/jpeg", previewFilename(result.filename));
        if (!savedPreview?.path?.trim()) throw new Error("preview save returned no path");
        record.previewPath = savedPreview.path;
        record.stages.push("preview_generated");
      } catch {
        if (await this.removePath(removeMedia, record.originalPath)) record.originalPath = undefined;
        if (await this.removePath(removeMedia, record.previewPath)) record.previewPath = undefined;
        record.errorCode = "MEDIA_PREVIEW_FAILED";
        record.stages.push("preview_failed");
        this.entries.set(hash, record); this.persist();
        return { ok: false, code: "MEDIA_PREVIEW_FAILED" };
      }
    }

    record.stages.push("extraction_skipped");
    record.status = "processed";
    record.updatedAt = now;
    this.entries.set(hash, record);
    this.persist();
    return { ok: true, hash, mime, originalPath: original.path, previewPath: record.previewPath, record: this.copy(record) };
  }
}

export function loadMediaPipeline(accountId: string, stateDir?: string): MediaPipeline { return new MediaPipeline(accountId, stateDir); }
