import type { Chat, Message } from "@kyan-du/agent-wechat-shared";

export type CursorSelection = {
  firstPoll: boolean;
  prevLastSeen: number;
  messages: Message[];
  seedLastSeen?: number;
};

export type HandledCursor = {
  localId: number;
  messageKey: string;
};

export type StartupBaseline = {
  localId: number;
  messageKey?: string;
};

export function cursorMessageKey(message: Message): string {
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
  startupBaseline?: StartupBaseline,
): CursorSelection {
  const firstPoll = !lastSeenId.has(chatId);
  const prevLastSeen = lastSeenId.get(chatId) ?? 0;
  const sorted = [...messages].sort((a, b) => a.localId - b.localId);
  const baselineActive =
    startupBaseline !== undefined && (firstPoll || prevLastSeen < startupBaseline.localId);

  if (baselineActive) {
    const live = sorted.filter((message) =>
      message.localId > startupBaseline.localId ||
      (
        message.localId === startupBaseline.localId &&
        startupBaseline.messageKey !== undefined &&
        cursorMessageKey(message) !== startupBaseline.messageKey
      )
    );
    const seedLastSeen = sorted
      .filter((message) => message.localId <= startupBaseline.localId)
      .at(-1)?.localId;

    return {
      firstPoll,
      prevLastSeen,
      messages: live,
      seedLastSeen,
    };
  }

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

export function seedStartupBaselineFromChat(chat: Chat): StartupBaseline | undefined {
  return typeof chat.lastMsgLocalId === "number" && chat.lastMsgLocalId > 0
    ? { localId: chat.lastMsgLocalId }
    : undefined;
}

export function enrichStartupBaselineFromMessages(
  baseline: StartupBaseline | undefined,
  messages: Message[],
): StartupBaseline | undefined {
  if (baseline === undefined || baseline.messageKey !== undefined) return baseline;
  const match = messages.find((message) => message.localId === baseline.localId);
  return match ? { ...baseline, messageKey: cursorMessageKey(match) } : baseline;
}

export function selectMessagesHandledAfterDispatch(
  messages: Message[],
  successfulSegmentLastLocalIds: number[],
): Message[] {
  if (successfulSegmentLastLocalIds.length === 0) return [];
  const lastHandled = Math.max(...successfulSegmentLastLocalIds);
  return messages.filter((message) => message.localId <= lastHandled);
}
