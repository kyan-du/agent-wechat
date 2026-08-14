import type { SendParams } from "@agent-wechat/shared";

export function buildOpenClawConfirmedSend(params: {
  chatId: string;
  text: string;
  confirmed: boolean;
}): SendParams | null {
  if (params.confirmed !== true) return null;
  return {
    chatId: params.chatId,
    text: params.text,
    source: "openclaw",
    similarityConfirmed: true,
  };
}
