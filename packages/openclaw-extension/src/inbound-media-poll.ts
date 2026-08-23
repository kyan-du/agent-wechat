import type { MediaResult } from "@kyan-du/agent-wechat-shared";

type MediaClient = { getMedia(chatId: string, localId: number): Promise<MediaResult> };

export async function pollMedia(
  client: MediaClient,
  chatId: string,
  localId: number,
  log?: { info?: (...args: any[]) => void },
  maxAttempts = 15,
  intervalMs = 1000,
): Promise<MediaResult | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.getMedia(chatId, localId);
    if (result.type === "unsupported") return null;
    if (result.data) return result;
    if (attempt < maxAttempts) {
      log?.info?.(`[wechat:media] pending attempt=${attempt}/${maxAttempts}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}
