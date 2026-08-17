import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cursorMessageKey } from "./monitor-cursor.ts";
import type { MessageScanContinuation } from "./monitor-scan.js";

export const MAX_PENDING_RESET_CHATS = 100;
export const MAX_PENDING_RESET_MESSAGES = 10_000;
export const MAX_RESET_RETRY_DELAY_MS = 60_000;

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

export function loadPendingResetRetries(
  accountId: string,
  stateDir?: string,
): Map<string, MessageScanContinuation> {
  try {
    const raw = JSON.parse(readFileSync(retryStorePath(accountId, stateDir), "utf8")) as {
      entries?: Array<[string, MessageScanContinuation]>;
    };
    const entries = Array.isArray(raw.entries) ? raw.entries.slice(-MAX_PENDING_RESET_CHATS) : [];
    return new Map(entries.filter(([, pending]) =>
      pending?.readyForDispatch === true && Array.isArray(pending.messages)
    ));
  } catch {
    return new Map();
  }
}

export function persistPendingResetRetries(
  accountId: string,
  pending: Map<string, MessageScanContinuation>,
  stateDir?: string,
): void {
  const path = retryStorePath(accountId, stateDir);
  const entries = [...pending.entries()].filter(([, value]) => value.readyForDispatch);
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

function enforcePendingBounds(state: MonitorRetryState): void {
  while (state.pendingMessageScans.size > MAX_PENDING_RESET_CHATS) {
    const oldest = state.pendingMessageScans.keys().next().value;
    if (oldest === undefined) break;
    state.pendingMessageScans.delete(oldest);
  }
  let total = [...state.pendingMessageScans.values()]
    .reduce((sum, pending) => sum + pending.messages.length, 0);
  while (total > MAX_PENDING_RESET_MESSAGES && state.pendingMessageScans.size > 0) {
    const oldest = state.pendingMessageScans.keys().next().value;
    if (oldest === undefined) break;
    total -= state.pendingMessageScans.get(oldest)?.messages.length ?? 0;
    state.pendingMessageScans.delete(oldest);
  }
}

export function trimPendingResetRetries(state: MonitorRetryState): void {
  enforcePendingBounds(state);
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
  state.pendingMessageScans.delete(chatId);
  state.pendingMessageScans.set(chatId, {
    chat,
    messages: mergeMessages(existing?.messages ?? [], messages),
    generationReset: true,
    readyForDispatch: true,
    retryCount: existing?.retryCount ?? 0,
    nextRetryAt: existing?.nextRetryAt ?? now,
    createdAt: existing?.createdAt ?? now,
  });
  enforcePendingBounds(state);
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
  // Current chat snapshots win over stale pending metadata.
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
  state.lastSeenId.set(chatId, cursor);
  const pending = state.pendingMessageScans.get(chatId);
  if (!pending?.readyForDispatch) return;
  const remaining = pending.messages.filter((message) => message.localId > cursor);
  if (remaining.length === 0) {
    state.pendingMessageScans.delete(chatId);
  } else {
    state.pendingMessageScans.set(chatId, {
      ...pending,
      messages: remaining,
      retryCount: 0,
      nextRetryAt: 0,
    });
  }
  persist(state);
}
