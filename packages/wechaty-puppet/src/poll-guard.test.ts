import assert from 'node:assert/strict'
import test from 'node:test'
import { runPollIfIdle, type PollGuard } from './poll-guard.js'

test('runPollIfIdle drops overlapping ticks', async () => {
  const guard: PollGuard = { inFlight: false }
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let calls = 0

  const first = runPollIfIdle(guard, async () => {
    calls++
    await blocked
  })
  const second = await runPollIfIdle(guard, async () => { calls++ })

  assert.equal(second, false)
  assert.equal(calls, 1)
  release()
  assert.equal(await first, true)
  assert.equal(guard.inFlight, false)
})

test('runPollIfIdle releases the guard after an error', async () => {
  const guard: PollGuard = { inFlight: false }
  await assert.rejects(
    runPollIfIdle(guard, async () => { throw new Error('poll failed') }),
    /poll failed/,
  )
  assert.equal(guard.inFlight, false)
  assert.equal(await runPollIfIdle(guard, async () => {}), true)
})
