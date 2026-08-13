export type PollLifecycle = {
  generation: number
  inFlight?: Promise<boolean>
}

export type PollContext = {
  isCurrent: () => boolean
}

export function startPollLifecycle(lifecycle: PollLifecycle): number {
  lifecycle.generation++
  return lifecycle.generation
}

/** Run one poll at a time; interval ticks arriving while busy are dropped. */
export function runPollIfIdle(
  lifecycle: PollLifecycle,
  generation: number,
  poll: (context: PollContext) => Promise<void>,
): Promise<boolean> {
  if (lifecycle.inFlight) return Promise.resolve(false)

  const isCurrent = () => lifecycle.generation === generation
  let active!: Promise<boolean>
  active = (async () => {
    if (!isCurrent()) return false
    await poll({ isCurrent })
    return true
  })().finally(() => {
    if (lifecycle.inFlight === active) lifecycle.inFlight = undefined
  })
  lifecycle.inFlight = active
  return active
}

export function invalidatePollLifecycle(lifecycle: PollLifecycle): void {
  lifecycle.generation++
}

/** Invalidate the current generation and wait for its active poll to settle. */
export async function stopPollLifecycle(lifecycle: PollLifecycle): Promise<void> {
  invalidatePollLifecycle(lifecycle)
  await lifecycle.inFlight
}
