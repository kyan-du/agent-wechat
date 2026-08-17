import type { Chat, Message } from "@kyan-du/agent-wechat-shared";

export type CursorSelection = {
  firstPoll: boolean;
  prevLastSeen: number;
  messages: Message[];
  seedLastSeen?: number;
};

export type StartupLiveBoundary = {
  isStartupLive: boolean;
  messages: Message[];
  backlogMessages: Message[];
};

export type HandledCursor = {
  localId: number;
  messageKey: string;
};

function cursorMessageKey(message: Message): string {
  return `${message.serverId ?? ""}:${message.timestamp}:${message.type}:${message.sender ?? ""}:${message.content ?? ""}`;
}

export function markEqualCursorUnreadHandled(
  chatId: string,
  message: Message | undefined,
  equalCursorUnreadHandled: Map<string, HandledCursor>,
): void {
  if (message === undefined) return;
  equalCursorUnreadHandled.set(chatId, {
    localId: message.localId,
    messageKey: cursorMessageKey(message),
  });
}

export function markCursorMessagesHandled(
  chatId: string,
  messages: Message[],
  equalCursorUnreadHandled: Map<string, HandledCursor>,
): number | undefined {
  if (messages.length === 0) return undefined;
  const cursorMessage = messages.reduce((latest, message) =>
    message.localId > latest.localId ? message : latest
  );
  markEqualCursorUnreadHandled(chatId, cursorMessage, equalCursorUnreadHandled);
  return cursorMessage.localId;
}

export function selectCursorMessages(
  chatId: string,
  chat: Chat,
  messages: Message[],
  lastSeenId: Map<string, number>,
  equalCursorUnreadHandled: Map<string, HandledCursor>,
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
    (() => {
      const handled = equalCursorUnreadHandled.get(chatId);
      return handled?.localId !== prevLastSeen ||
        handled.messageKey !== cursorMessageKey(equalCursorUnread[0]);
    })();

  return {
    firstPoll,
    prevLastSeen,
    messages: recoverable ? equalCursorUnread : [],
  };
}

export function applyStartupLiveBoundary(
  selection: CursorSelection,
  monitorStartedAtMs: number,
): StartupLiveBoundary {
  if (!selection.firstPoll || selection.messages.length === 0) {
    return {
      isStartupLive: false,
      messages: selection.messages,
      backlogMessages: [],
    };
  }

  const sorted = [...selection.messages].sort((a, b) => a.localId - b.localId);
  const firstLiveIndex = sorted.findIndex((message) => {
    const timestamp = Date.parse(message.timestamp);
    return Number.isFinite(timestamp) && timestamp >= monitorStartedAtMs;
  });

  if (firstLiveIndex < 0) {
    return {
      isStartupLive: false,
      messages: sorted,
      backlogMessages: [],
    };
  }

  return {
    isStartupLive: true,
    messages: sorted.slice(firstLiveIndex),
    backlogMessages: sorted.slice(0, firstLiveIndex),
  };
}
