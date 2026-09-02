import type { MediaResult } from "@kyan-du/agent-wechat-shared";

type MediaClient = { getMedia(chatId: string, localId: number): Promise<MediaResult> };
type MediaRetryTrigger = (result: MediaResult, attempt: number) => Promise<void>;
type ImageMaterializationClient = {
  openChat(chatId: string, clearUnreads?: boolean, signal?: AbortSignal): Promise<unknown>;
};


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

// Keep a missing local image from serially blocking the rest of an inbound batch.
export const DEFAULT_MEDIA_POLL_ATTEMPTS = 6;
export const DEFAULT_MEDIA_POLL_INTERVAL_MS = 500;
// Overlay openChat can stall ~60s on UNKNOWN_UI_STATE_TIMEOUT. Bound the trigger
// so the short media poll window still returns even if UI never settles.
export const IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS = 400;

export type ImageMaterializationTriggerOptions = {
  log?: { info?: (...args: any[]) => void };
  timeoutMs?: number;
  // Catch-up processUnreadChat(..., skipOpen=true) must still reopen for type=3.
  // This flag is accepted so callers can pass skipOpen without gating the trigger.
  skipOpen?: boolean;
};

export function createImageMaterializationTrigger(
  client: ImageMaterializationClient,
  chatId: string,
  options?: ImageMaterializationTriggerOptions,
): MediaRetryTrigger {
  const timeoutMs = options?.timeoutMs ?? IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS;
  return async (result, attempt) => {
    if (result.type === "file") return;
    options?.log?.info?.(
      `[wechat:media] triggering chat reopen for image attempt=${attempt} skipOpen=${options?.skipOpen === true}`,
    );
    const controller = new AbortController();
    const opened = Promise.resolve(client.openChat(chatId, true, controller.signal));
    // Prevent a later overlay timeout from becoming an unhandled rejection after we move on.
    void opened.catch(() => undefined);
    try {
      await raceWithTimeout(opened, timeoutMs);
    } finally {
      controller.abort();
    }
  };
}

export function imageMaterializationTriggerForMessage(opts: {
  client: ImageMaterializationClient;
  chatId: string;
  messageType: number;
  log?: { info?: (...args: any[]) => void };
  timeoutMs?: number;
  skipOpen?: boolean;
}): MediaRetryTrigger | undefined {
  const baseType = opts.messageType & 0x7fffffff;
  if (baseType !== 3) return undefined;
  return createImageMaterializationTrigger(opts.client, opts.chatId, {
    log: opts.log,
    timeoutMs: opts.timeoutMs,
    skipOpen: opts.skipOpen,
  });
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT"), {
        code: "IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT",
      }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  log?.info?.(
    `[wechat:media] retry exhausted attempts=${maxAttempts} elapsedMs=${Date.now() - startedAt} code=${lastResult?.errorCode ?? "MEDIA_NOT_DOWNLOADED"}`,
  );
  return lastResult ?? null;
}
