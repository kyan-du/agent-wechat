import type { Chat, Message } from "@kyan-du/agent-wechat-shared";
import type { MessageScanContinuation } from "./monitor-scan.js";

export type MonitorRetryState = {
  pendingMessageScans: Map<string, MessageScanContinuation>;
  lastSeenId: Map<string, number>;
};

export function queueResetGenerationRetry(
  state: MonitorRetryState,
  chatId: string,
  chat: Chat,
  messages: Message[],
): void {
  state.pendingMessageScans.set(chatId, {
    chat,
    messages,
    generationReset: true,
    readyForDispatch: true,
  });
}

export function monitorChatsToProcess(
  chats: Chat[],
  state: MonitorRetryState,
): Map<string, Chat> {
  const result = new Map<string, Chat>();
  for (const chat of chats) {
    const chatId = chat.username ?? chat.id;
    if (chat.unreadCount > 0) result.set(chatId, chat);
  }
  for (const pending of state.pendingMessageScans.values()) {
    const chatId = pending.chat.username ?? pending.chat.id;
    result.set(chatId, pending.chat);
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
    state.pendingMessageScans.set(chatId, { ...pending, messages: remaining });
  }
}
