import fs from "node:fs";
import path from "node:path";
import TOML from "smol-toml";

export const OUTBOUND_ENV_KEYS = [
  "AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY", "AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS", "AGENT_WECHAT_OUTBOUND_JITTER_MS",
  "AGENT_WECHAT_CHAT_COOLDOWN_MS", "AGENT_WECHAT_HOURLY_BUDGET", "AGENT_WECHAT_DAILY_BUDGET",
  "AGENT_WECHAT_QUIET_START_MIN", "AGENT_WECHAT_QUIET_END_MIN", "AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS",
  "AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT", "AGENT_WECHAT_OUTBOUND_TASK_TTL_MS", "AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_TTL_MS",
  "AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS", "AGENT_WECHAT_OUTBOUND_DISABLED",
] as const;
export type OutboundConfig = Partial<Record<typeof OUTBOUND_ENV_KEYS[number], string>>;
const aliases: Record<string, typeof OUTBOUND_ENV_KEYS[number]> = {
  queueCapacity: "AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY", minSpacingMs: "AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS", jitterMs: "AGENT_WECHAT_OUTBOUND_JITTER_MS",
  chatCooldownMs: "AGENT_WECHAT_CHAT_COOLDOWN_MS", hourlyBudget: "AGENT_WECHAT_HOURLY_BUDGET", dailyBudget: "AGENT_WECHAT_DAILY_BUDGET",
  quietStartMin: "AGENT_WECHAT_QUIET_START_MIN", quietEndMin: "AGENT_WECHAT_QUIET_END_MIN",
  longTailJitterMs: "AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS", longTailChancePercent: "AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT",
  taskTtlMs: "AGENT_WECHAT_OUTBOUND_TASK_TTL_MS", idempotencyTtlMs: "AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_TTL_MS",
  idempotencyMaxRows: "AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS", disabled: "AGENT_WECHAT_OUTBOUND_DISABLED",
};
export function readOutboundConfig(file: string): OutboundConfig {
  if (!file) return {};
  const parsed = TOML.parse(fs.readFileSync(path.resolve(file), "utf8")) as Record<string, unknown>;
  const result: OutboundConfig = {};
  for (const [key, env] of Object.entries(aliases)) if (parsed[key] !== undefined) result[env] = String(parsed[key]);
  for (const key of OUTBOUND_ENV_KEYS) if (parsed[key] !== undefined) result[key] = String(parsed[key]);
  return result;
}
export function outboundFromEnvEntries(entries: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set<string>(OUTBOUND_ENV_KEYS);
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index > 0 && allowed.has(entry.slice(0, index))) result[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return result;
}

export function resolveOutboundConfig(file?: string, cli: OutboundConfig = {}): OutboundConfig {
  const config = file ? readOutboundConfig(file) : {};
  const env: OutboundConfig = {};
  for (const key of OUTBOUND_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...config, ...env, ...cli };
}
