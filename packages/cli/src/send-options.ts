import type { SendParams } from "@kyan-du/agent-wechat-shared";

export function buildCliSendParams(options: {
  chatId: string;
  text?: string;
  image?: SendParams["image"];
  file?: SendParams["file"];
  confirmSimilar?: boolean;
  idempotencyKey?: string;
}): SendParams {
  const chatId = options.chatId.trim();
  if (!chatId) throw new Error("chatId must contain non-whitespace characters");
  const payloadCount = [options.text, options.image, options.file].filter((value) => value !== undefined).length;
  if (payloadCount !== 1) throw new Error("exactly one of text, image, or file is required");
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
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    source: "cli",
  };
}
