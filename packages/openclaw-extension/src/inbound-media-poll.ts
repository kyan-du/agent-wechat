import type { MediaResult } from "@kyan-du/agent-wechat-shared";

type MediaClient = { getMedia(chatId: string, localId: number): Promise<MediaResult> };
type MediaRetryTrigger = (result: MediaResult, attempt: number) => Promise<void>;

// These errors mean WeChat has not finished materializing the local media yet.
// Validation and authentication failures remain terminal and are returned immediately.
const RETRYABLE_MEDIA_ERRORS = new Set([
  "MEDIA_NOT_DOWNLOADED",
  "IMAGE_RESOURCE_UNAVAILABLE",
  "FILE_NOT_DOWNLOADED",
  "FILE_NOT_STABLE",
  "VOICE_NOT_DOWNLOADED",
  "IMAGE_NOT_STABLE",
]);

export const DEFAULT_MEDIA_POLL_ATTEMPTS = 30;
export const DEFAULT_MEDIA_POLL_INTERVAL_MS = 1000;

function isRetryable(result: MediaResult): boolean {
  if (result.data !== undefined) return false;
  if (result.errorCode !== undefined) return RETRYABLE_MEDIA_ERRORS.has(result.errorCode);
  return result.type === "pending";
}

export async function pollMedia(
  client: MediaClient,
  chatId: string,
  localId: number,
  log?: { info?: (...args: any[]) => void },
  maxAttempts = DEFAULT_MEDIA_POLL_ATTEMPTS,
  intervalMs = DEFAULT_MEDIA_POLL_INTERVAL_MS,
  onRetryTrigger?: MediaRetryTrigger,
): Promise<MediaResult | null> {
  let lastResult: MediaResult | undefined;
  let triggerUsed = false;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.getMedia(chatId, localId);
    lastResult = result;
    if (result.type === "unsupported") return result;
    if (result.data || !isRetryable(result)) return result;
    if (!triggerUsed && onRetryTrigger) {
      triggerUsed = true;
      try {
        await onRetryTrigger(result, attempt);
        log?.info?.(`[wechat:media] download trigger completed attempt=${attempt}`);
      } catch {
        log?.info?.(`[wechat:media] download trigger failed attempt=${attempt} code=MEDIA_DOWNLOAD_TRIGGER_FAILED`);
      }
    }
    if (attempt < maxAttempts) {
      log?.info?.(`[wechat:media] pending attempt=${attempt}/${maxAttempts} elapsedMs=${Date.now() - startedAt}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  log?.info?.(`[wechat:media] pending exhausted attempts=${maxAttempts} elapsedMs=${Date.now() - startedAt}`);
  return lastResult ?? null;
}
