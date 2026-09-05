/**
 * Skip WeChat official/service chats in the unread monitor.
 *
 * `gh_` official accounts match packages/wechaty-puppet/src/type-map.ts.
 * System usernames match packages/agent-server-rust/src/tools/wechat_contacts.rs
 * (`SYSTEM_USERNAMES`, "Known system/internal usernames to exclude from contact listings").
 */
const SYSTEM_SERVICE_USERNAMES = new Set([
  "qmessage",
  "floatbottle",
  "medianote",
  "notifymessage",
  "weixin",
  "fmessage",
  "filehelper",
  "newsapp",
  "tmessage",
  "mphelper",
  "qqmail",
  "weixingongzhong",
  "qqsafe",
  "exmail_tool",
  "lbsapp",
  "pc_qq",
]);

export const EMPTY_UNREAD_BACKOFF_MS = 5_000;
export const EMPTY_UNREAD_BACKOFF_MAX_MS = 60_000;

export type EmptyUnreadBackoff = Map<string, { nextRetryAt: number; retryCount: number }>;

/** Official/service accounts (`gh_`) and known WeChat system chats. */
export function isOfficialAccount(chatId: string): boolean {
  return chatId.startsWith("gh_") || SYSTEM_SERVICE_USERNAMES.has(chatId);
}

export function isMonitorUnreadChat(chat: {
  unreadCount: number;
  username?: string;
  id: string;
}): boolean {
  return chat.unreadCount > 0 && !isOfficialAccount(chat.username ?? chat.id);
}

export function isEmptyUnreadBackoffActive(
  backoff: EmptyUnreadBackoff,
  chatId: string,
  now = Date.now(),
): boolean {
  const entry = backoff.get(chatId);
  return entry !== undefined && now < entry.nextRetryAt;
}

/**
 * Unstick firstPoll and back off when unreadCount>0 but listMessages returned nothing.
 * Does not open the chat: opening would clear unread before rows are visible.
 */
export function applyEmptyUnreadSkip(
  chatId: string,
  opts: {
    unreadCount: number;
    firstPoll: boolean;
    prevLastSeen: number;
    lastSeenId: Map<string, number>;
    backoff: EmptyUnreadBackoff;
    now?: number;
  },
): { seededLastSeen: boolean; backoffMs: number } | null {
  if (opts.unreadCount <= 0) return null;
  const now = opts.now ?? Date.now();
  const seededLastSeen = opts.firstPoll && !opts.lastSeenId.has(chatId);
  if (seededLastSeen) {
    opts.lastSeenId.set(chatId, opts.prevLastSeen);
  }
  const retryCount = (opts.backoff.get(chatId)?.retryCount ?? 0) + 1;
  const backoffMs = Math.min(
    EMPTY_UNREAD_BACKOFF_MAX_MS,
    EMPTY_UNREAD_BACKOFF_MS * 2 ** Math.min(retryCount - 1, 6),
  );
  opts.backoff.set(chatId, { nextRetryAt: now + backoffMs, retryCount });
  return { seededLastSeen, backoffMs };
}
