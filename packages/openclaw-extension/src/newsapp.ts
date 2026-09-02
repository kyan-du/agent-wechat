import type { Chat, Message } from "@kyan-du/agent-wechat-shared";

export const NEWSAPP_USERNAME = "newsapp";

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
  const preview = chat.lastMessagePreview?.trim();
  if (!preview || typeof chat.lastMsgLocalId !== "number") return null;
  const urls = extractNewsappUrls(preview);
  const urlBlock = urls.length > 0 ? `\nLinks:\n${urls.join("\n")}` : "";
  return {
    localId: chat.lastMsgLocalId,
    serverId: chat.lastMsgLocalId,
    chatId: chat.username || chat.id,
    type: 1,
    content: `[Tencent News]\n${preview}${urlBlock}`,
    timestamp: chat.lastActivityAt || new Date().toISOString(),
    sender: NEWSAPP_USERNAME,
    senderName: "腾讯新闻",
  };
}

export function shouldSkipNewsappOpen(chat: Pick<Chat, "id" | "username">): boolean {
  return isNewsappChat(chat);
}
