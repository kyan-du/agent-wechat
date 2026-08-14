import type { SendParams } from "@agent-wechat/shared";

export function buildCliSendParams(options: {
  chatId: string;
  text?: string;
  image?: SendParams["image"];
  file?: SendParams["file"];
  confirmSimilar?: boolean;
}): SendParams {
  return {
    chatId: options.chatId,
    ...(options.text ? { text: options.text } : {}),
    ...(options.image ? { image: options.image } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(options.confirmSimilar === true ? { similarityConfirmed: true } : {}),
    source: "cli",
  };
}
