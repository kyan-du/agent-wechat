import type { SendParams } from '@agent-wechat/shared'

export function buildWechatyTextSend(
  chatId: string,
  text: string,
  explicitlyConfirmed: boolean = false,
): SendParams {
  return {
    chatId,
    text,
    source: 'wechaty',
    ...(explicitlyConfirmed ? { similarityConfirmed: true } : {}),
  }
}
