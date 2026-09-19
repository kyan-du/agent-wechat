import type { MonitorInterest, WeChatClient } from "@kyan-du/agent-wechat-shared";
import type { ResolvedWeChatAccount } from "./types.js";

function normalizeAllowFrom(values: Array<string | number> | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values ?? []) {
    let id = String(entry).trim();
    if (!id) continue;
    if (id !== "*") {
      id = id.replace(/^(agent-wechat|wechat):/i, "").trim();
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function buildMonitorInterest(account: ResolvedWeChatAccount): MonitorInterest {
  return {
    dmPolicy: account.dmPolicy ?? "disabled",
    dmAllowFrom: normalizeAllowFrom(account.allowFrom),
    groupPolicy: account.groupPolicy ?? "allowlist",
    groupAllowFrom: normalizeAllowFrom(account.groupAllowFrom),
    includeSystemFeeds: true,
  };
}

export function monitorInterestFingerprint(interest: MonitorInterest): string {
  return JSON.stringify({
    dmPolicy: interest.dmPolicy,
    dmAllowFrom: [...(interest.dmAllowFrom ?? [])].sort(),
    groupPolicy: interest.groupPolicy ?? "allowlist",
    groupAllowFrom: [...(interest.groupAllowFrom ?? [])].sort(),
    includeSystemFeeds: interest.includeSystemFeeds !== false,
  });
}

/** True when the monitor should ask agent-server to hide out-of-interest DMs. */
export function shouldListChatsInterestOnly(interest: MonitorInterest): boolean {
  return interest.dmPolicy === "allowlist" || interest.dmPolicy === "disabled";
}

export type EnsureMonitorInterestResult = {
  interest: MonitorInterest;
  /** Server currently holds this interest (GET match or successful PUT). */
  synced: boolean;
};

/**
 * Keep agent-server's in-memory interest aligned with the live OpenClaw account config.
 *
 * - GET every call so a server restart (interest wiped) is detected.
 * - PUT only when missing or mismatched.
 * - `synced` is true only when the server holds the desired allowlist; callers must not
 *   set `interestOnly=true` until then (fail-open keeps denied DMs visible in listChats).
 */
export async function ensureMonitorInterestSynced(
  client: WeChatClient,
  account: ResolvedWeChatAccount,
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
): Promise<EnsureMonitorInterestResult> {
  const interest = buildMonitorInterest(account);
  const desiredFp = monitorInterestFingerprint(interest);
  try {
    const current = await client.getMonitorInterest();
    const serverInterest = current.interest;
    if (serverInterest && monitorInterestFingerprint(serverInterest) === desiredFp) {
      return { interest, synced: true };
    }
    await client.setMonitorInterest(interest);
    log?.info?.(
      `[wechat:${account.accountId}] Synced monitor interest to agent-server (dmPolicy=${interest.dmPolicy}, dmAllowFrom=${interest.dmAllowFrom.length})`,
    );
    return { interest, synced: true };
  } catch (err) {
    log?.error?.(
      `[wechat:${account.accountId}] Failed to sync monitor interest: ${err}`,
    );
    return { interest, synced: false };
  }
}
