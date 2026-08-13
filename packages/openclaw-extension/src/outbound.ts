import { randomUUID } from "node:crypto";
import type { SendParams, SendResult } from "@agent-wechat/shared";

export type LogicalSendParams = SendParams & {
  idempotencyKey?: string;
  requestId?: string;
  partIndex?: number;
  partCount?: number;
};

export type LogicalSendClient = {
  sendMessage(params: LogicalSendParams): Promise<SendResult>;
};

export type MediaPart =
  | { image: NonNullable<SendParams["image"]> }
  | { file: NonNullable<SendParams["file"]> };

export async function sendLogicalMediaTask(opts: {
  client: LogicalSendClient;
  chatId: string;
  media: MediaPart[];
  caption?: string;
  requestId?: string;
  interPartDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const requestId = opts.requestId ?? randomUUID();
  const parts: Array<Omit<SendParams, "chatId">> = [
    ...opts.media,
    ...(opts.caption ? [{ text: opts.caption }] : []),
  ];
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = opts.interPartDelayMs ?? 750;

  for (let index = 0; index < parts.length; index++) {
    const result = await opts.client.sendMessage({
      chatId: opts.chatId,
      ...parts[index],
      requestId,
      idempotencyKey: `${requestId}:${index}`,
      partIndex: index,
      partCount: parts.length,
    });
    if (!result.success) {
      throw new Error(result.error ?? `Logical send part ${index + 1} failed`);
    }
    if (index + 1 < parts.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return requestId;
}
