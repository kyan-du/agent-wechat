export type WeChatDmPolicy = "allowlist" | "open" | "disabled";
export type WeChatGroupPolicy = "open" | "disabled" | "allowlist";

export type WeChatGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  groupPolicy?: WeChatGroupPolicy;
  allowFrom?: string[];
};

export type WeChatConfig = {
  enabled?: boolean;
  serverUrl: string;
  token?: string;
  dmPolicy?: WeChatDmPolicy;
  allowFrom?: string[];
  groupPolicy?: WeChatGroupPolicy;
  groupAllowFrom?: string[];
  groups?: Record<string, WeChatGroupConfig>;
  pollIntervalMs?: number;
  authPollIntervalMs?: number;
  catchUpMode?: "read-only" | "latest";
  catchUpMaxMessages?: number;
  catchUpMaxAgeMs?: number;
  mediaPartDelayMs?: number;
};

export type ResolvedWeChatAccount = {
  accountId: string;
  enabled: boolean;
  serverUrl: string;
  token?: string;
  dmPolicy: WeChatDmPolicy;
  allowFrom: string[];
  groupPolicy: WeChatGroupPolicy;
  groupAllowFrom: string[];
  groups: Record<string, WeChatGroupConfig>;
  pollIntervalMs: number;
  authPollIntervalMs: number;
  catchUpMode: "read-only" | "latest";
  catchUpMaxMessages: number;
  catchUpMaxAgeMs: number;
  mediaPartDelayMs: number;
};

function normalizeDmPolicy(policy: unknown): WeChatDmPolicy {
  return policy === "allowlist" || policy === "open" || policy === "disabled"
    ? policy
    : "disabled";
}

function normalizeGroupPolicy(policy: unknown): WeChatGroupPolicy {
  return policy === "open" || policy === "disabled" || policy === "allowlist"
    ? policy
    : "disabled";
}

function boundedInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fallback;
}

// Defaults
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_AUTH_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_CATCH_UP_MAX_MESSAGES = 10;
export const DEFAULT_CATCH_UP_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_MEDIA_PART_DELAY_MS = 750;
export const DEFAULT_ACCOUNT_ID = "default";

export function resolveWeChatAccount(
  cfg: Record<string, unknown>,
  accountId?: string,
): ResolvedWeChatAccount | null {
  const wechat = (cfg as { channels?: { wechat?: WeChatConfig } }).channels
    ?.wechat;
  if (!wechat?.serverUrl) return null;

  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: wechat.enabled !== false,
    serverUrl: wechat.serverUrl,
    token: wechat.token,
    dmPolicy: normalizeDmPolicy(wechat.dmPolicy),
    allowFrom: wechat.allowFrom ?? [],
    groupPolicy: normalizeGroupPolicy(wechat.groupPolicy),
    groupAllowFrom: wechat.groupAllowFrom ?? [],
    groups: wechat.groups ?? {},
    pollIntervalMs: wechat.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    authPollIntervalMs:
      wechat.authPollIntervalMs ?? DEFAULT_AUTH_POLL_INTERVAL_MS,
    catchUpMode: wechat.catchUpMode === "latest" ? "latest" : "read-only",
    catchUpMaxMessages: boundedInteger(
      wechat.catchUpMaxMessages,
      DEFAULT_CATCH_UP_MAX_MESSAGES,
      1,
    ),
    catchUpMaxAgeMs: boundedInteger(
      wechat.catchUpMaxAgeMs,
      DEFAULT_CATCH_UP_MAX_AGE_MS,
      1000,
    ),
    mediaPartDelayMs: boundedInteger(
      wechat.mediaPartDelayMs,
      DEFAULT_MEDIA_PART_DELAY_MS,
      0,
    ),
  };
}
