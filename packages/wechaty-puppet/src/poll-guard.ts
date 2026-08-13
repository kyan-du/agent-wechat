export type PollGuard = { inFlight: boolean };

/** Run one poll at a time; interval ticks arriving while busy are dropped. */
export async function runPollIfIdle(
  guard: PollGuard,
  poll: () => Promise<void>,
): Promise<boolean> {
  if (guard.inFlight) return false;

  guard.inFlight = true;
  try {
    await poll();
    return true;
  } finally {
    guard.inFlight = false;
  }
}
