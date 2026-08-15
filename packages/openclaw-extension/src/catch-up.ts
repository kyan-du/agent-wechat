import type { Message } from "@kyan-du/agent-wechat-shared";

export type CatchUpMode = "read-only" | "latest";

export type CatchUpLimits = {
  maxMessages: number;
  maxAgeMs: number;
  nowMs?: number;
};

export type CatchUpSelection = {
  messages: Message[];
  cursor: number;
  skipped: number;
};

export function recoveryCursor(selection: CatchUpSelection): number {
  return selection.cursor;
}

export function isCatchUpBatch(messages: Message[], limits: CatchUpLimits): boolean {
  if (messages.length > limits.maxMessages) return true;

  const nowMs = limits.nowMs ?? Date.now();
  const cutoff = nowMs - limits.maxAgeMs;
  return messages.some((message) => {
    const timestamp = Date.parse(message.timestamp);
    return !Number.isFinite(timestamp) || timestamp < cutoff || timestamp > nowMs;
  });
}

/** Select a bounded, recent suffix and advance past every observed message. */
export function selectCatchUpMessages(
  messages: Message[],
  limits: CatchUpLimits,
  mode: CatchUpMode = "latest",
): CatchUpSelection {
  if (messages.length === 0) {
    return { messages: [], cursor: 0, skipped: 0 };
  }

  const sorted = [...messages].sort((a, b) => a.localId - b.localId);
  const cursor = sorted[sorted.length - 1].localId;
  const nowMs = limits.nowMs ?? Date.now();
  const cutoff = nowMs - limits.maxAgeMs;
  const recent = sorted.filter((message) => {
    const timestamp = Date.parse(message.timestamp);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs;
  });
  const bounded = recent.slice(-limits.maxMessages);
  const selected = mode === "read-only" ? [] : bounded;

  return {
    messages: selected,
    cursor,
    skipped: sorted.length - selected.length,
  };
}
