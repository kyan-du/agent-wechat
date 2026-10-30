import type { Message } from "@kyan-du/agent-wechat-shared";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cursorMessageKey } from "./monitor-cursor.ts";
import { quarantineDurableJson, readDurableJson, recoverDurableQuarantine, removeDurableJson, updateDurableJson, writeDurableJson } from "./durable-store.ts";

export type InboundEventStatus = "pending" | "processing" | "processed" | "failed" | "dead_letter";
export type InboundEventOutcome = "dispatched" | "filtered" | "buffered" | "read_only" | "stale";

export type InboundEventRecord = {
  eventId: string;
  chatId: string;
  localId: number;
  messageKey: string;
  status: InboundEventStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextRetryAt?: number;
  lastErrorCode?: string;
  outcome?: InboundEventOutcome;
};

type LedgerFile = { version: 1; entries: InboundEventRecord[] };

export const MAX_INBOUND_LEDGER_ENTRIES = 10_000;
export const MAX_INBOUND_EVENT_ATTEMPTS = 5;
export const MAX_INBOUND_RETRY_DELAY_MS = 60_000;
export const MAX_INBOUND_MESSAGE_KEY_LENGTH = 4096;
export const MAX_INBOUND_CHAT_ID_LENGTH = 512;
export const MAX_INBOUND_ERROR_CODE_LENGTH = 128;

/** Clamp a string to `max` UTF-16 units. Over-long values keep a readable
 * prefix plus a sha256 of the full value, so distinct inputs stay distinct and
 * the stored value always passes read validation. */
export function boundLedgerString(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = `#sha256:${createHash("sha256").update(value).digest("hex")}`;
  let prefix = value.slice(0, Math.max(0, max - suffix.length));
  // Do not leave a dangling high surrogate at the cut.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

export class InboundLedgerStateError extends Error {
  readonly code = "INBOUND_LEDGER_BLOCKED" as const;
  constructor(message: string) {
    super(message);
    this.name = "InboundLedgerStateError";
  }
}

function statePath(accountId: string, stateDir?: string): string {
  const root = stateDir ?? process.env.OPENCLAW_STATE_DIR?.trim() ?? join(homedir(), ".openclaw");
  const safeAccount = accountId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(root, "wechat", `inbound-ledger-${safeAccount}.json`);
}

function quarantinePath(path: string): string { return `${path}.corrupt`; }
function blockerPath(path: string): string { return `${path}.blocked`; }
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncParent(path: string): void { syncFile(dirname(path)); }

function validRecord(value: unknown): value is InboundEventRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.eventId === "string" && /^[a-f0-9]{64}$/.test(row.eventId) &&
    typeof row.chatId === "string" && row.chatId.length > 0 && row.chatId.length <= MAX_INBOUND_CHAT_ID_LENGTH &&
    Number.isSafeInteger(row.localId) && typeof row.messageKey === "string" && row.messageKey.length <= MAX_INBOUND_MESSAGE_KEY_LENGTH &&
    ["pending", "processing", "processed", "failed", "dead_letter"].includes(String(row.status)) &&
    Number.isSafeInteger(row.attempts) && Number(row.attempts) >= 0 &&
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) &&
    typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) &&
    (row.nextRetryAt === undefined || (typeof row.nextRetryAt === "number" && Number.isFinite(row.nextRetryAt))) &&
    (row.lastErrorCode === undefined || typeof row.lastErrorCode === "string") &&
    (row.outcome === undefined || ["dispatched", "filtered", "buffered", "read_only", "stale"].includes(String(row.outcome)));
}

export type LedgerLogger = { warn: (message: string) => void };
const defaultLogger: LedgerLogger = { warn: (message) => console.warn(message) };

/** Keep only well-formed, unique entries. One bad row must never take the
 * whole channel down, so invalid or duplicate rows are dropped with a warning. */
function sanitizeEntries(raw: unknown[], logger: LedgerLogger, source: string): InboundEventRecord[] {
  const byId = new Map<string, InboundEventRecord>();
  let invalid = 0;
  let duplicate = 0;
  for (const entry of raw) {
    if (!validRecord(entry)) { invalid += 1; continue; }
    if (byId.has(entry.eventId)) duplicate += 1;
    byId.set(entry.eventId, entry);
  }
  if (invalid || duplicate) {
    logger.warn(`[agent-wechat] inbound ledger ${source}: dropped ${invalid} invalid and ${duplicate} duplicate event(s)`);
  }
  return [...byId.values()];
}

function validateFile(value: unknown, logger: LedgerLogger, source: string): LedgerFile {
  if (!value || typeof value !== "object") throw new InboundLedgerStateError("inbound ledger is not an object");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.entries) || row.entries.length > MAX_INBOUND_LEDGER_ENTRIES) {
    throw new InboundLedgerStateError("inbound ledger schema or capacity is invalid");
  }
  return { version: 1, entries: sanitizeEntries(row.entries as unknown[], logger, source) };
}

function loadFile(path: string, logger: LedgerLogger): LedgerFile {
  if (existsSync(blockerPath(path))) {
    throw new InboundLedgerStateError(`inbound ledger is blocked: ${blockerPath(path)}`);
  }
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = readDurableJson<unknown>(path);
    if (parsed === undefined) return { version: 1, entries: [] };
    return validateFile(parsed, logger, path);
  } catch (error) {
    const quarantine = quarantinePath(path);
    try {
      quarantineDurableJson(path, blockerPath(path));
    } catch (quarantineError) {
      throw new InboundLedgerStateError(`inbound ledger quarantine failed: ${String(quarantineError)}`);
    }
    throw new InboundLedgerStateError(`inbound ledger quarantined at ${quarantine}: ${String(error)}`);
  }
}

function writeFile(path: string, file: LedgerFile): void {
  writeDurableJson(path, file);
}

export function inboundEventId(accountId: string, chatId: string, message: Message): string {
  return createHash("sha256")
    .update(`${accountId}\0${chatId}\0${cursorMessageKey(message)}`)
    .digest("hex");
}

/** Bind a nested attachment to its parent without inventing message localIds.
 * Server filenames retain the original dataitem index even in partial results.
 */
export function nestedMediaEventId(parentEventId: string, item: { type?: string; filename?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(["nested-media", parentEventId, item.type ?? "", item.filename ?? ""]))
    .digest("hex");
}

export class InboundEventLedger {
  private readonly path: string;
  private readonly entries = new Map<string, InboundEventRecord>();
  private readonly logger: LedgerLogger;

  constructor(accountId: string, stateDir?: string, logger: LedgerLogger = defaultLogger) {
    this.path = statePath(accountId, stateDir);
    this.logger = logger;
    recoverDurableQuarantine(this.path);
    for (const entry of loadFile(this.path, logger).entries) this.entries.set(entry.eventId, entry);
  }

  private persist(): void {
    const localEntries = [...this.entries.values()];
    const next = updateDurableJson<LedgerFile>(this.path, (current) => {
      const onDisk = Array.isArray(current?.entries) ? sanitizeEntries(current.entries, this.logger, this.path) : [];
      const merged = new Map(onDisk.map((entry) => [entry.eventId, entry]));
      for (const entry of localEntries) if (validRecord(entry)) merged.set(entry.eventId, entry);
      const entries = [...merged.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.eventId.localeCompare(b.eventId));
      if (entries.length > MAX_INBOUND_LEDGER_ENTRIES) {
        const retained = entries.filter((entry) => entry.status !== "processed");
        if (retained.length > MAX_INBOUND_LEDGER_ENTRIES) throw new InboundLedgerStateError("inbound ledger capacity exceeded");
        return { version: 1, entries: retained };
      }
      return { version: 1, entries };
    });
    this.entries.clear();
    for (const entry of next.entries) this.entries.set(entry.eventId, entry);
  }

  get(eventId: string): InboundEventRecord | undefined {
    const entry = this.entries.get(eventId);
    return entry ? { ...entry } : undefined;
  }

  ensure(accountId: string, chatId: string, message: Message, now = Date.now()): string {
    const eventId = inboundEventId(accountId, chatId, message);
    if (!this.entries.has(eventId)) {
      this.entries.set(eventId, {
        eventId,
        chatId: boundLedgerString(chatId, MAX_INBOUND_CHAT_ID_LENGTH),
        localId: message.localId,
        messageKey: boundLedgerString(cursorMessageKey(message), MAX_INBOUND_MESSAGE_KEY_LENGTH),
        status: "pending", attempts: 0, createdAt: now, updatedAt: now,
      });
      this.persist();
    }
    return eventId;
  }

  shouldProcess(eventId: string, now = Date.now()): boolean {
    const entry = this.entries.get(eventId);
    if (!entry || entry.status === "processed" || entry.status === "dead_letter") return false;
    return entry.status !== "failed" || (entry.nextRetryAt ?? 0) <= now;
  }

  markProcessing(eventId: string, now = Date.now()): void {
    const entry = this.entries.get(eventId);
    if (!entry || !this.shouldProcess(eventId, now)) return;
    entry.status = "processing";
    entry.attempts += 1;
    entry.updatedAt = now;
    entry.nextRetryAt = undefined;
    this.persist();
  }

  markProcessed(eventId: string, outcome: InboundEventOutcome, now = Date.now()): void {
    const entry = this.entries.get(eventId);
    if (!entry) return;
    entry.status = "processed";
    entry.outcome = outcome;
    entry.updatedAt = now;
    entry.nextRetryAt = undefined;
    entry.lastErrorCode = undefined;
    this.persist();
  }

  markFailed(eventId: string, errorCode: string, now = Date.now()): void {
    const entry = this.entries.get(eventId);
    if (!entry) return;
    entry.updatedAt = now;
    entry.lastErrorCode = boundLedgerString(errorCode, MAX_INBOUND_ERROR_CODE_LENGTH);
    if (entry.attempts >= MAX_INBOUND_EVENT_ATTEMPTS) {
      entry.status = "dead_letter";
      entry.nextRetryAt = undefined;
    } else {
      entry.status = "failed";
      entry.nextRetryAt = now + Math.min(MAX_INBOUND_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(entry.attempts - 1, 6));
    }
    this.persist();
  }

  list(filter?: { chatId?: string; status?: InboundEventStatus; since?: number }): InboundEventRecord[] {
    return [...this.entries.values()]
      .filter((entry) => (!filter?.chatId || entry.chatId === filter.chatId) &&
        (!filter?.status || entry.status === filter.status) &&
        (!filter?.since || entry.updatedAt >= filter.since))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ ...entry }));
  }

  markProcessedBatch(eventIds: string[], outcome: InboundEventOutcome, now = Date.now()): void {
    for (const eventId of eventIds) this.markProcessed(eventId, outcome, now);
  }

  markFailedBatch(eventIds: string[], errorCode: string, now = Date.now()): void {
    for (const eventId of eventIds) this.markFailed(eventId, errorCode, now);
  }

  replay(eventId: string, now = Date.now()): boolean {
    const entry = this.entries.get(eventId);
    if (!entry || entry.status === "processed") return false;
    entry.status = "pending";
    entry.updatedAt = now;
    entry.nextRetryAt = now;
    entry.lastErrorCode = undefined;
    this.persist();
    return true;
  }
}

export function loadInboundEventLedger(accountId: string, stateDir?: string, logger?: LedgerLogger): InboundEventLedger {
  return new InboundEventLedger(accountId, stateDir, logger);
}
