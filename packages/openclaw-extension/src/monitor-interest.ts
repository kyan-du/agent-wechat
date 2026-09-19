import type { MonitorInterest, WeChatClient } from "@kyan-du/agent-wechat-shared";
import type { ResolvedWeChatAccount } from "./types.ts";

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

export async function syncMonitorInterest(
  client: WeChatClient,
  account: ResolvedWeChatAccount,
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
): Promise<{ interest: MonitorInterest; fingerprint: string }> {
  const interest = buildMonitorInterest(account);
  const fingerprint = monitorInterestFingerprint(interest);
  try {
    await client.setMonitorInterest(interest);
    log?.info?.(
      `[wechat:${account.accountId}] Synced monitor interest to agent-server (dmPolicy=${interest.dmPolicy}, dmAllowFrom=${interest.dmAllowFrom.length})`,
    );
  } catch (err) {
    log?.error?.(
      `[wechat:${account.accountId}] Failed to sync monitor interest: ${err}`,
    );
  }
  return { interest, fingerprint };
}
