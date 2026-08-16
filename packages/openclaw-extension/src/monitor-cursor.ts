import type { Chat, Message } from "@kyan-du/agent-wechat-shared";

export type CursorSelection = {
  firstPoll: boolean;
  prevLastSeen: number;
  messages: Message[];
  seedLastSeen?: number;
};

export function equalCursorUnreadKey(chatId: string, localId: number): string {
  return `${chatId}:${localId}`;
}

export function markEqualCursorUnreadHandled(
  chatId: string,
  localId: number | undefined,
  equalCursorUnreadHandled: Set<string>,
): void {
  if (localId === undefined) return;
  equalCursorUnreadHandled.add(equalCursorUnreadKey(chatId, localId));
}

export function markCursorMessagesHandled(
  chatId: string,
  messages: Message[],
  equalCursorUnreadHandled: Set<string>,
): number | undefined {
  if (messages.length === 0) return undefined;
  const cursor = Math.max(...messages.map((message) => message.localId));
  markEqualCursorUnreadHandled(chatId, cursor, equalCursorUnreadHandled);
  return cursor;
}

export function selectCursorMessages(
  chatId: string,
  chat: Chat,
  messages: Message[],
  lastSeenId: Map<string, number>,
  equalCursorUnreadHandled: Set<string>,
): CursorSelection {
  const firstPoll = !lastSeenId.has(chatId);
  const prevLastSeen = lastSeenId.get(chatId) ?? 0;
  const sorted = [...messages].sort((a, b) => a.localId - b.localId);

  if (firstPoll) {
    const unread = chat.unreadCount ?? 0;
    if (unread > 0 && unread < sorted.length) {
      return {
        firstPoll,
        prevLastSeen,
        messages: sorted.slice(-unread),
        seedLastSeen: sorted[sorted.length - unread - 1].localId,
      };
    }
    if (unread >= sorted.length) {
      return { firstPoll, prevLastSeen, messages: sorted };
    }
    return {
      firstPoll,
      prevLastSeen,
      messages: [],
      seedLastSeen: sorted[sorted.length - 1]?.localId,
    };
  }

  const newer = sorted.filter((m) => m.localId > prevLastSeen);
  if (newer.length > 0) {
    return { firstPoll, prevLastSeen, messages: newer };
  }

  const unread = chat.unreadCount ?? 0;
  if (unread <= 0) {
    return { firstPoll, prevLastSeen, messages: [] };
  }

  const unreadSuffix = sorted.slice(-Math.min(unread, sorted.length));
  const equalCursorUnread = unreadSuffix.filter((m) => m.localId === prevLastSeen);
  const recoverable =
    equalCursorUnread.length === 1 &&
    chat.lastMsgLocalId === prevLastSeen &&
    !equalCursorUnreadHandled.has(equalCursorUnreadKey(chatId, prevLastSeen));

  return {
    firstPoll,
    prevLastSeen,
    messages: recoverable ? equalCursorUnread : [],
  };
}
