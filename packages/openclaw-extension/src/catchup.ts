/** Human catch-up after reconnect: fold by chat, never spray one reply per missed message. */

export const DEFAULT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_CATCHUP_BUDGET = 5;

export type CatchupAction = "dispatch" | "skip_stale" | "defer";

export interface CatchupInput {
  isReconnect: boolean;
  isGroup: boolean;
  mentioned: boolean;
  newestTimestampMs: number;
  nowMs: number;
  staleAfterMs?: number;
  catchupDispatched: number;
  catchupBudget?: number;
}

export interface CatchupDecision {
  action: CatchupAction;
  reason: string;
}

export function decideCatchup(input: CatchupInput): CatchupDecision {
  const staleAfter = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const budget = input.catchupBudget ?? DEFAULT_CATCHUP_BUDGET;
  const age = input.nowMs - input.newestTimestampMs;

  if (!input.isReconnect) {
    return { action: "dispatch", reason: "live" };
  }

  if (input.isGroup && !input.mentioned && age > staleAfter) {
    return { action: "skip_stale", reason: "stale_group" };
  }

  if (input.catchupDispatched >= budget) {
    return { action: "defer", reason: "catchup_budget" };
  }

  return { action: "dispatch", reason: "catchup_fold" };
}

/** One reconnect window: at most one outbound decision per chat. */
export function shouldFoldSegments(isReconnect: boolean): boolean {
  return isReconnect;
}

/** End reconnect once the backlog is drained, or the catch-up budget is spent. */
export function nextReconnectState(input: {
  reconnect: boolean;
  unreadCount: number;
  deferred: number;
  dispatched: number;
  budget?: number;
}): { reconnect: boolean; dispatched: number } {
  if (!input.reconnect) {
    return { reconnect: false, dispatched: 0 };
  }
  const budget = input.budget ?? DEFAULT_CATCHUP_BUDGET;
  if (input.unreadCount === 0 && input.deferred === 0) {
    return { reconnect: false, dispatched: 0 };
  }
  if (input.deferred === 0 || input.dispatched >= budget) {
    return { reconnect: false, dispatched: 0 };
  }
  return { reconnect: true, dispatched: input.dispatched };
}
