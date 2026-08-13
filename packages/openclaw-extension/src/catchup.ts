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
    return { action: "defer", reason: "catchup_hold" };
  }

  return { action: "dispatch", reason: "catchup_fold" };
}

/** One reconnect window: at most one outbound decision per chat. */
export function shouldFoldSegments(isReconnect: boolean): boolean {
  return isReconnect;
}

/**
 * Stay in reconnect while leftover backlog exists.
 * Budget never flips remaining chats to live; they stay held (no auto-send).
 * Raise `catchUpChatBudget` (hot-reload) to continue held chats, still one
 * send per poll. Held chats are not dropped from lastSeen.
 */
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

/** Same control flow as startWeChatMonitor: one allowDispatch slot per poll. */
export function simulateReconnectPolls(
  chatCount: number,
  budget = DEFAULT_CATCHUP_BUDGET,
  maxTicks = 20,
  budgetAtTick?: (tick: number) => number,
): { ticks: number[]; reconnect: boolean; dispatched: number } {
  let remaining = chatCount;
  let reconnect = true;
  let dispatched = 0;
  const ticks: number[] = [];
  for (let i = 0; i < maxTicks && reconnect && remaining > 0; i++) {
    if (budgetAtTick) {
      budget = budgetAtTick(i);
    }
    let dispatchedThisTick = 0;
    let deferred = 0;
    for (let c = 0; c < remaining; c++) {
      const decision = decideCatchup({
        isReconnect: true,
        isGroup: false,
        mentioned: false,
        newestTimestampMs: Date.now(),
        nowMs: Date.now(),
        catchupDispatched: dispatched,
        catchupBudget: budget,
      });
      const allow = dispatchedThisTick < 1;
      if (decision.action === "dispatch" && allow) {
        dispatchedThisTick += 1;
        dispatched += 1;
      } else {
        deferred += 1;
      }
    }
    remaining = deferred;
    ticks.push(dispatchedThisTick);
    const next = nextReconnectState({
      reconnect: true,
      unreadCount: remaining + dispatchedThisTick,
      deferred,
      dispatched,
      budget,
    });
    reconnect = next.reconnect;
    if (!next.reconnect) {
      dispatched = 0;
    }
  }
  return { ticks, reconnect, dispatched };
}
