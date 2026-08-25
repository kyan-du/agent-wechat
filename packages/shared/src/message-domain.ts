import type { ChatSyncPage, MediaReference, Message } from "./types/index.js";

export const MESSAGE_DOMAIN_SCHEMA_VERSION = 1 as const;

export type MessageCursor = {
  timestamp: string;
  localId: number;
};

export type MessageEnvelope = {
  schemaVersion: typeof MESSAGE_DOMAIN_SCHEMA_VERSION;
  message: Message;
  media: MediaReference[];
};

/** Stable identity used by cursors, ledgers, and reset recovery. */
export function messageIdentityKey(message: Pick<Message, "serverId" | "timestamp" | "type" | "sender" | "content">): string {
  return `${message.serverId ?? ""}:${message.timestamp}:${message.type}:${message.sender ?? ""}:${message.content ?? ""}`;
}

export function messageCursor(message: Pick<Message, "timestamp" | "localId">): MessageCursor {
  return { timestamp: message.timestamp, localId: message.localId };
}

export function compareMessageCursor(left: MessageCursor, right: MessageCursor): number {
  const timestamp = left.timestamp.localeCompare(right.timestamp);
  return timestamp || left.localId - right.localId;
}

/** Project the wire page into per-message envelopes without changing the API payload. */
export function messageEnvelopes(page: Pick<ChatSyncPage, "items" | "media">): MessageEnvelope[] {
  const mediaByLocalId = new Map<number, MediaReference[]>();
  for (const reference of page.media) {
    const refs = mediaByLocalId.get(reference.localId) ?? [];
    refs.push({ ...reference });
    mediaByLocalId.set(reference.localId, refs);
  }
  return page.items.map((message) => ({
    schemaVersion: MESSAGE_DOMAIN_SCHEMA_VERSION,
    message,
    media: mediaByLocalId.get(message.localId) ?? [],
  }));
}
