import type { Chat, Message } from "@kyan-du/agent-wechat-shared";

export const NEWSAPP_USERNAME = "newsapp";
export const MAX_NEWSAPP_PREVIEW_CHARS = 4_000;

export function isNewsappChat(chat: Pick<Chat, "id" | "username">): boolean {
  return (chat.username || chat.id) === NEWSAPP_USERNAME;
}

const URL_RE = /https?:\/\/[^\s<>，。；！？）】》]+/gi;

export function extractNewsappUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])].map((url) =>
    url.replace(/[),.;!?，。；！？）】》]+$/u, ""),
  );
}

type NewsappChat = Pick<Chat, "id" | "username"> & {
  lastMessagePreview?: string;
  lastMsgLocalId?: number;
  lastActivityAt?: string;
};

export function newsappFallbackMessage(chat: NewsappChat): Message | null {
  const rawPreview = chat.lastMessagePreview?.trim();
  const preview = rawPreview?.slice(0, MAX_NEWSAPP_PREVIEW_CHARS);
  const localId = chat.lastMsgLocalId;
  if (!preview || typeof localId !== "number" || !Number.isSafeInteger(localId) || localId <= 0) return null;
  const urls = extractNewsappUrls(preview);
  const urlBlock = urls.length > 0 ? `\nLinks:\n${urls.join("\n")}` : "";
  return {
    localId,
    serverId: localId,
    chatId: chat.username || chat.id,
    type: 1,
    content: `[Tencent News]\n${preview}${urlBlock}`,
    timestamp: chat.lastActivityAt || `1970-01-01T00:00:${String(localId % 60).padStart(2, "0")}.000Z`,
    sender: NEWSAPP_USERNAME,
    senderName: "腾讯新闻",
  };
}

export function shouldSkipNewsappOpen(chat: Pick<Chat, "id" | "username">): boolean {
  return isNewsappChat(chat);
}

/** System-feed messages do not require a user pairing/allowlist grant. */
export function shouldBypassNewsappAuthorization(
  chat: Pick<Chat, "id" | "username">,
): boolean {
  return isNewsappChat(chat);
}
