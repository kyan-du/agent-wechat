import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OUTBOUND_ENV_KEYS, readOutboundConfig, resolveOutboundConfig } from "./outbound-config.ts";

test("TOML maps all outbound policy fields and precedence is CLI > env > TOML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-outbound-"));
  const file = path.join(dir, "policy.toml");
  fs.writeFileSync(file, `queueCapacity=1\nlongTailJitterMs=2\nlongTailChancePercent=3\ntaskTtlMs=4\nidempotencyTtlMs=5\nidempotencyMaxRows=6\ndisabled=true\n`);
  const old = process.env.AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY;
  process.env.AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY = "env";
  try {
    const toml = readOutboundConfig(file);
    assert.deepEqual(toml, {
      AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY: "1", AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS: "2",
      AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT: "3", AGENT_WECHAT_OUTBOUND_TASK_TTL_MS: "4",
      AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_TTL_MS: "5", AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS: "6",
      AGENT_WECHAT_OUTBOUND_DISABLED: "true",
    });
    const resolved = resolveOutboundConfig(file, { AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY: "cli" });
    assert.equal(resolved.AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY, "cli");
    assert.equal(resolved.AGENT_WECHAT_OUTBOUND_DISABLED, "true");
    assert.equal(Object.keys(resolved).length, 7);
    assert.equal(OUTBOUND_ENV_KEYS.length, 14);
  } finally { if (old === undefined) delete process.env.AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY; else process.env.AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY = old; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("outbound values are not rendered by config module", () => {
  const source = fs.readFileSync(new URL("./outbound-config.ts", import.meta.url), "utf8");
  assert.equal(source.includes("console.log"), false);
  assert.equal(source.includes("console.error"), false);
});
