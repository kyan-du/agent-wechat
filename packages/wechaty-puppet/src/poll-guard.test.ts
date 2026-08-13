import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runPollIfIdle,
  startPollLifecycle,
  stopPollLifecycle,
  type PollLifecycle,
} from './poll-guard.js'

test('runPollIfIdle drops overlapping ticks', async () => {
  const lifecycle: PollLifecycle = { generation: 0 }
  const generation = startPollLifecycle(lifecycle)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let calls = 0

  const first = runPollIfIdle(lifecycle, generation, async () => {
    calls++
    await blocked
  })
  const second = await runPollIfIdle(lifecycle, generation, async () => { calls++ })

  assert.equal(second, false)
  assert.equal(calls, 1)
  release()
  assert.equal(await first, true)
  assert.equal(lifecycle.inFlight, undefined)
})

test('runPollIfIdle releases the lifecycle after an error', async () => {
  const lifecycle: PollLifecycle = { generation: 0 }
  const generation = startPollLifecycle(lifecycle)
  await assert.rejects(
    runPollIfIdle(lifecycle, generation, async () => { throw new Error('poll failed') }),
    /poll failed/,
  )
  assert.equal(lifecycle.inFlight, undefined)
  assert.equal(await runPollIfIdle(lifecycle, generation, async () => {}), true)
})

test('stop invalidates a blocked poll and waits for it before restart', async () => {
  const lifecycle: PollLifecycle = { generation: 0 }
  const generation = startPollLifecycle(lifecycle)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const effects: string[] = []

  const poll = runPollIfIdle(lifecycle, generation, async ({ isCurrent }) => {
    await blocked
    if (isCurrent()) effects.push('message')
  })
  const stopped = stopPollLifecycle(lifecycle)

  assert.equal(await runPollIfIdle(lifecycle, generation, async () => {
    effects.push('stale')
  }), false)
  release()
  await stopped
  await poll
  assert.deepEqual(effects, [])

  const restarted = startPollLifecycle(lifecycle)
  assert.equal(await runPollIfIdle(lifecycle, restarted, async ({ isCurrent }) => {
    if (isCurrent()) effects.push('heartbeat')
  }), true)
  assert.deepEqual(effects, ['heartbeat'])
})
