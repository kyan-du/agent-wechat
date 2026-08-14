import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWechatyTextSend } from './send-confirmation.js'

test('normal Wechaty sends never confirm similar content automatically', () => {
  assert.equal(buildWechatyTextSend('chat', 'text').similarityConfirmed, undefined)
})

test('Wechaty confirmation flag requires the explicit confirmed path', () => {
  const params = buildWechatyTextSend(' chat ', ' text ', true)
  assert.equal(params.similarityConfirmed, true)
  assert.equal(params.chatId, 'chat')
  assert.equal(params.text, 'text')
})

test('Wechaty rejects blank recipients or text', () => {
  assert.throws(() => buildWechatyTextSend(' ', 'text'), /chatId/)
  assert.throws(() => buildWechatyTextSend('chat', '\n'), /text/)
})
