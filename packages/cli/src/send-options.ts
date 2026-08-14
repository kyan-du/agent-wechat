import type { SendParams } from "@agent-wechat/shared";

export function buildCliSendParams(options: {
  chatId: string;
  text?: string;
  image?: SendParams["image"];
  file?: SendParams["file"];
  confirmSimilar?: boolean;
}): SendParams {
  const chatId = options.chatId.trim();
  if (!chatId) throw new Error("chatId must contain non-whitespace characters");
  const text = options.text?.trim();
  if (options.text !== undefined && !text) {
    throw new Error("text must contain non-whitespace characters");
  }
  return {
    chatId,
    ...(text ? { text } : {}),
    ...(options.image ? { image: options.image } : {}),
    ...(options.file ? { file: options.file } : {}),
    ...(options.confirmSimilar === true ? { similarityConfirmed: true } : {}),
    source: "cli",
  };
}
