import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cursorMessageKey } from "./monitor-cursor.ts";
import type { MessageScanContinuation } from "./monitor-scan.js";

export const MAX_PENDING_RESET_CHATS = 100;
export const MAX_PENDING_RESET_MESSAGES = 10_000;
export const MAX_RESET_RETRY_DELAY_MS = 60_000;

export class PendingRetryStateError extends Error {
  readonly code: "RETRY_STATE_CORRUPT" | "RETRY_CAPACITY";

  constructor(message: string, code: "RETRY_STATE_CORRUPT" | "RETRY_CAPACITY") {
    super(message);
    this.name = "PendingRetryStateError";
    this.code = code;
  }
}

export type MonitorRetryState = {
  pendingMessageScans: Map<string, MessageScanContinuation>;
  lastSeenId: Map<string, number>;
  persist?: () => void;
};

function retryStorePath(accountId: string, stateDir?: string): string {
  const root = stateDir ?? process.env.OPENCLAW_STATE_DIR?.trim() ?? join(homedir(), ".openclaw");
  const safeAccount = accountId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(root, "wechat", `monitor-retry-${safeAccount}.json`);
}

function validateEntries(entries: Array<[string, MessageScanContinuation]>): void {
  if (entries.length > MAX_PENDING_RESET_CHATS) {
    throw new PendingRetryStateError("WeChat pending retry chat capacity exceeded", "RETRY_CAPACITY");
  }
  let total = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new PendingRetryStateError("WeChat retry state entry is invalid", "RETRY_STATE_CORRUPT");
    }
    const pending = entry[1];
    if (pending?.readyForDispatch !== true || !Array.isArray(pending.messages)) {
      throw new PendingRetryStateError("WeChat pending retry payload is invalid", "RETRY_STATE_CORRUPT");
    }
    total += pending.messages.length;
  }
  if (total > MAX_PENDING_RESET_MESSAGES) {
    throw new PendingRetryStateError("WeChat pending retry message capacity exceeded", "RETRY_CAPACITY");
  }
}

export function loadPendingResetRetries(
  accountId: string,
  stateDir?: string,
): Map<string, MessageScanContinuation> {
  const path = retryStorePath(accountId, stateDir);
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; entries?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.entries)) {
      throw new PendingRetryStateError("WeChat retry state schema is invalid", "RETRY_STATE_CORRUPT");
    }
    const entries = raw.entries as Array<[string, MessageScanContinuation]>;
    validateEntries(entries);
    return new Map(entries);
  } catch (error) {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try {
      copyFileSync(path, quarantine);
    } catch {
      // Preserve the original even if quarantine creation itself fails.
    }
    if (error instanceof PendingRetryStateError) throw error;
    throw new PendingRetryStateError(
      `WeChat retry state is unreadable at ${path}; preserved for recovery (${String(error)})`,
      "RETRY_STATE_CORRUPT",
    );
  }
}

export function persistPendingResetRetries(
  accountId: string,
  pending: Map<string, MessageScanContinuation>,
  stateDir?: string,
): void {
  const path = retryStorePath(accountId, stateDir);
  const entries = [...pending.entries()].filter(([, value]) => value.readyForDispatch);
  validateEntries(entries);
  if (entries.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
  renameSync(temp, path);
}

function persist(state: MonitorRetryState): void {
  state.persist?.();
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const merged = new Map<string, Message>();
  for (const message of [...current, ...incoming]) {
    merged.set(cursorMessageKey(message), message);
  }
  return [...merged.values()].sort((a, b) => a.localId - b.localId);
}

function assertStateCapacity(pending: Map<string, MessageScanContinuation>): void {
  validateEntries([...pending.entries()]);
}

export function trimPendingResetRetries(state: MonitorRetryState): void {
  assertStateCapacity(state.pendingMessageScans);
  persist(state);
}

export function clearPendingResetRetry(state: MonitorRetryState, chatId: string): void {
  if (state.pendingMessageScans.delete(chatId)) persist(state);
}

export function queueResetGenerationRetry(
  state: MonitorRetryState,
  chatId: string,
  chat: Chat,
  messages: Message[],
  now = Date.now(),
): void {
  const existing = state.pendingMessageScans.get(chatId);
  const merged = mergeMessages(existing?.messages ?? [], messages);
  const next: MessageScanContinuation = {
    chat,
    messages: merged,
    generationReset: true,
    readyForDispatch: true,
    retryCount: existing?.retryCount ?? 0,
    nextRetryAt: existing?.nextRetryAt ?? now,
    createdAt: existing?.createdAt ?? now,
  };
  const projected = new Map(state.pendingMessageScans);
  projected.set(chatId, next);
  assertStateCapacity(projected);
  state.pendingMessageScans.delete(chatId);
  state.pendingMessageScans.set(chatId, next);
  persist(state);
}

export function mergePendingResetMessages(
  state: MonitorRetryState,
  chatId: string,
  chat: Chat,
  messages: Message[],
): Message[] {
  const pending = state.pendingMessageScans.get(chatId);
  if (!pending?.readyForDispatch) return messages;
  const merged = mergeMessages(pending.messages, messages);
  const projected = new Map(state.pendingMessageScans);
  projected.set(chatId, { ...pending, chat, messages: merged });
  assertStateCapacity(projected);
  state.pendingMessageScans.set(chatId, { ...pending, chat, messages: merged });
  persist(state);
  return merged;
}

export function recordResetRetryFailure(
  state: MonitorRetryState,
  chatId: string,
  now = Date.now(),
): void {
  const pending = state.pendingMessageScans.get(chatId);
  if (!pending?.readyForDispatch) return;
  const retryCount = (pending.retryCount ?? 0) + 1;
  const delay = Math.min(MAX_RESET_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(retryCount - 1, 6));
  state.pendingMessageScans.set(chatId, {
    ...pending,
    retryCount,
    nextRetryAt: now + delay,
  });
  persist(state);
}

export function monitorChatsToProcess(
  chats: Chat[],
  state: MonitorRetryState,
  now = Date.now(),
): Map<string, Chat> {
  const result = new Map<string, Chat>();
  for (const pending of state.pendingMessageScans.values()) {
    const chatId = pending.chat.username ?? pending.chat.id;
    if ((pending.nextRetryAt ?? 0) <= now) result.set(chatId, pending.chat);
  }
  for (const chat of chats) {
    const chatId = chat.username ?? chat.id;
    if (chat.unreadCount > 0 || state.pendingMessageScans.has(chatId)) result.set(chatId, chat);
  }
  return result;
}

export function commitResetDispatchPrefix(
  state: MonitorRetryState,
  chatId: string,
  cursor: number | undefined,
): void {
  if (cursor === undefined) return;
  const pending = state.pendingMessageScans.get(chatId);
  if (!pending?.readyForDispatch) {
    state.lastSeenId.set(chatId, cursor);
    return;
  }
  const remaining = pending.messages.filter((message) => message.localId > cursor);
  const projected = new Map(state.pendingMessageScans);
  if (remaining.length === 0) {
    projected.delete(chatId);
  } else {
    projected.set(chatId, { ...pending, messages: remaining, retryCount: 0, nextRetryAt: 0 });
  }
  assertStateCapacity(projected);
  state.lastSeenId.set(chatId, cursor);
  state.pendingMessageScans.clear();
  for (const [key, value] of projected) state.pendingMessageScans.set(key, value);
  persist(state);
}
