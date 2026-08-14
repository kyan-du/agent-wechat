import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWechatyTextSend } from './send-confirmation.js'

test('normal Wechaty sends never confirm similar content automatically', () => {
  assert.equal(buildWechatyTextSend('chat', 'text').similarityConfirmed, undefined)
})

test('Wechaty confirmation flag requires the explicit confirmed path', () => {
  assert.equal(buildWechatyTextSend('chat', 'text', true).similarityConfirmed, true)
})
