import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "@kyan-du/agent-wechat-shared";
import {
  InboundEventLedger,
  InboundLedgerStateError,
  MAX_INBOUND_EVENT_ATTEMPTS,
  inboundEventId,
} from "./monitor-ledger.ts";

function message(localId: number, content = `message-${localId}`): Message {
  return {
    localId,
    serverId: 1000 + localId,
    chatId: "wxid_chat",
    sender: "wxid_sender",
    type: 1,
    content,
    timestamp: "2026-08-25T00:00:00.000Z",
  };
}

test("event id is stable and includes account, chat, and message identity", () => {
  assert.equal(inboundEventId("default", "wxid_chat", message(1)), inboundEventId("default", "wxid_chat", message(1)));
  assert.notEqual(inboundEventId("default", "wxid_chat", message(1)), inboundEventId("other", "wxid_chat", message(1)));
  assert.notEqual(inboundEventId("default", "wxid_chat", message(1)), inboundEventId("default", "wxid_other", message(1)));
  assert.notEqual(inboundEventId("default", "wxid_chat", message(1)), inboundEventId("default", "wxid_chat", message(1, "changed")));
});

test("ledger persists processing and terminal state across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-ledger-"));
  const first = new InboundEventLedger("default", dir);
  const id = first.ensure("default", "wxid_chat", message(1), 0);
  assert.equal(first.shouldProcess(id, 0), true);
  first.markProcessing(id, 0);
  first.markProcessed(id, "dispatched", 1);

  const restored = new InboundEventLedger("default", dir);
  assert.equal(restored.shouldProcess(id, 2), false);
  assert.equal(restored.get(id)?.outcome, "dispatched");
});

test("failed events back off and dead-letter after bounded attempts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-ledger-"));
  const ledger = new InboundEventLedger("default", dir);
  const id = ledger.ensure("default", "wxid_chat", message(1), 0);
  for (let attempt = 0; attempt < MAX_INBOUND_EVENT_ATTEMPTS; attempt += 1) {
    ledger.markProcessing(id, attempt * 100_000);
    ledger.markFailed(id, "DISPATCH_FAILED", attempt * 100_000);
  }
  assert.equal(ledger.get(id)?.status, "dead_letter");
  assert.equal(ledger.shouldProcess(id, Number.MAX_SAFE_INTEGER), false);
  assert.equal(ledger.replay(id, Number.MAX_SAFE_INTEGER), true);
  assert.equal(ledger.shouldProcess(id, Number.MAX_SAFE_INTEGER), true);
});

test("corrupt ledger is quarantined and blocks startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "wechat-ledger-"));
  mkdirSync(join(dir, "wechat"), { recursive: true });
  const path = join(dir, "wechat", "inbound-ledger-default.json");
  writeFileSync(path, "not-json");
  assert.throws(() => new InboundEventLedger("default", dir), InboundLedgerStateError);
  assert.throws(() => new InboundEventLedger("default", dir), (error: unknown) =>
    error instanceof InboundLedgerStateError && error.code === "INBOUND_LEDGER_BLOCKED"
  );
});
