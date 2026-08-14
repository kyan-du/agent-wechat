import type { SendParams } from '@agent-wechat/shared'

export function buildWechatyTextSend(
  chatId: string,
  text: string,
  explicitlyConfirmed: boolean = false,
): SendParams {
  const normalizedChatId = chatId.trim()
  const normalizedText = text.trim()
  if (!normalizedChatId) throw new Error('chatId must contain non-whitespace characters')
  if (!normalizedText) throw new Error('text must contain non-whitespace characters')
  return {
    chatId: normalizedChatId,
    text: normalizedText,
    source: 'wechaty',
    ...(explicitlyConfirmed ? { similarityConfirmed: true } : {}),
  }
}
