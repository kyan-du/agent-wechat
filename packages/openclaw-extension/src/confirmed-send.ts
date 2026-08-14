import type { SendParams } from "@agent-wechat/shared";

export function buildOpenClawConfirmedSend(params: {
  chatId: string;
  text: string;
  confirmed: boolean;
}): SendParams | null {
  if (params.confirmed !== true) return null;
  const chatId = params.chatId.trim();
  const text = params.text.trim();
  if (!chatId || !text) return null;
  return {
    chatId,
    text,
    source: "openclaw",
    similarityConfirmed: true,
  };
}
