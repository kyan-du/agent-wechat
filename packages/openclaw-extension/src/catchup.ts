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
  const age = input.nowMs - input.newestTimestampMs;

  if (!input.isReconnect) {
    return { action: "dispatch", reason: "live" };
  }

  if (input.isGroup && !input.mentioned && age > staleAfter) {
    return { action: "skip_stale", reason: "stale_group" };
  }

  return { action: "dispatch", reason: "catchup_fold" };
}

/** One reconnect window: at most one outbound decision per chat. */
export function shouldFoldSegments(isReconnect: boolean): boolean {
  return isReconnect;
}

/** Stay in reconnect until every deferred chat has been paced out. Budget never flips remaining work to live. */
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
  if (input.unreadCount === 0 && input.deferred === 0) {
    return { reconnect: false, dispatched: 0 };
  }
  if (input.deferred === 0) {
    return { reconnect: false, dispatched: 0 };
  }
  return { reconnect: true, dispatched: input.dispatched };
}

/** One paced reconnect tick: at most one dispatch, leftover stays deferred. */
export function tickReconnect(chats: number, alreadyDispatched: number): {
  dispatchedThisTick: number;
  deferred: number;
  dispatchedTotal: number;
} {
  if (chats <= 0) {
    return { dispatchedThisTick: 0, deferred: 0, dispatchedTotal: alreadyDispatched };
  }
  return {
    dispatchedThisTick: 1,
    deferred: chats - 1,
    dispatchedTotal: alreadyDispatched + 1,
  };
}
