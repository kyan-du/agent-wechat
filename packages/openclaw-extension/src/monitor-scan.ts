import type { Chat, CursorPage, Message } from "@kyan-du/agent-wechat-shared";
import type { StartupBaseline } from "./monitor-cursor.js";

export const MONITOR_CHAT_PAGE_LIMIT = 100;
export const MONITOR_MESSAGE_PAGE_LIMIT = 200;
export const DEFAULT_MESSAGE_PAGE_BUDGET = 50;
export const DEFAULT_INITIAL_CHAT_PAGE_BUDGET = 100;

export type ChatPageClient = {
  listChatsPage(
    limit?: number,
    cursor?: string,
    unreadOnly?: boolean,
  ): Promise<CursorPage<Chat>>;
};

export type MessagePageClient = {
  listMessagesPage(
    chatId: string,
    limit?: number,
    cursor?: string,
  ): Promise<CursorPage<Message>>;
};

export type ChatScanState = {
  cursor?: string;
  initialScanComplete: boolean;
};

export type MonitorChatPage = {
  chats: Chat[];
  isInitialSnapshot: boolean;
};

export async function listInitialMonitorChatSnapshot(
  client: ChatPageClient,
  state: ChatScanState,
  pageBudget = DEFAULT_INITIAL_CHAT_PAGE_BUDGET,
): Promise<Chat[]> {
  if (state.initialScanComplete) return [];
  const chats: Chat[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < pageBudget; pages += 1) {
    const page = await client.listChatsPage(MONITOR_CHAT_PAGE_LIMIT, cursor);
    chats.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) {
      state.initialScanComplete = true;
      state.cursor = undefined;
      return chats;
    }
  }
  throw new Error(`initial chat snapshot exceeded ${pageBudget} pages`);
}

export type MessageScanContinuation = {
  chat: Chat;
  cursor?: string;
  messages: Message[];
};

export type MonitorMessageScan = {
  messages: Message[];
  complete: boolean;
  nextCursor?: string;
  pagesScanned: number;
};

export async function listNextMonitorChatPage(
  client: ChatPageClient,
  state: ChatScanState,
): Promise<MonitorChatPage> {
  const isInitialSnapshot = !state.initialScanComplete;
  const page = await client.listChatsPage(MONITOR_CHAT_PAGE_LIMIT, state.cursor);
  state.cursor = page.nextCursor;
  if (!page.nextCursor) {
    state.initialScanComplete = true;
    state.cursor = undefined;
  }
  return { chats: page.items, isInitialSnapshot };
}

function hasReachedStableMessageBoundary(
  messages: Message[],
  chat: Chat,
  firstPoll: boolean,
  prevLastSeen: number,
  startupBaseline?: StartupBaseline,
): boolean {
  if (messages.length === 0) return false;
  const sorted = [...messages].sort((a, b) => a.localId - b.localId);

  if (startupBaseline !== undefined && (firstPoll || prevLastSeen < startupBaseline.localId)) {
    if (startupBaseline.localId <= 0) return true;
    if (sorted.some((message) => message.localId === startupBaseline.localId)) return true;
    // If pagination is exhausted, selection can distinguish an ID-generation reset
    // from startup history using the unread suffix. Keep paging until then.
    return false;
  }

  if (firstPoll) {
    const unread = chat.unreadCount ?? 0;
    if (unread > 0) return messages.length >= unread + 1;
    return true;
  }

  const unread = chat.unreadCount ?? 0;
  const possibleGenerationReset =
    unread > 0 &&
    typeof chat.lastMsgLocalId === "number" &&
    chat.lastMsgLocalId <= prevLastSeen;
  if (possibleGenerationReset) {
    // A reset can regrow to the old cursor. Read the full unread suffix before
    // identity comparison so an equal-ID replacement cannot hide older rows.
    return messages.length >= unread;
  }
  if (sorted.some((message) => message.localId <= prevLastSeen)) return true;
  return unread > 0 && messages.length >= unread;
}

export async function listMessagesForMonitorCursor(
  client: MessagePageClient,
  chatId: string,
  options: {
    chat: Chat;
    firstPoll: boolean;
    prevLastSeen: number;
    startupBaseline?: StartupBaseline;
    continuation?: MessageScanContinuation;
    pageBudget?: number;
  },
): Promise<MonitorMessageScan> {
  const pageBudget = options.pageBudget ?? DEFAULT_MESSAGE_PAGE_BUDGET;
  const messages = [...(options.continuation?.messages ?? [])];
  let cursor = options.continuation?.cursor;
  let pagesScanned = 0;

  while (pagesScanned < pageBudget) {
    const page = await client.listMessagesPage(chatId, MONITOR_MESSAGE_PAGE_LIMIT, cursor);
    pagesScanned += 1;
    messages.push(...page.items);
    cursor = page.nextCursor;

    if (
      !cursor ||
      hasReachedStableMessageBoundary(
        messages,
        options.chat,
        options.firstPoll,
        options.prevLastSeen,
        options.startupBaseline,
      )
    ) {
      return {
        messages,
        complete: true,
        nextCursor: undefined,
        pagesScanned,
      };
    }
  }

  return {
    messages,
    complete: false,
    nextCursor: cursor,
    pagesScanned,
  };
}
