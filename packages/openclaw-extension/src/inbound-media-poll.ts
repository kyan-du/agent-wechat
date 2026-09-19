import type { MediaResult } from "@kyan-du/agent-wechat-shared";

const DOWNLOADABLE_MEDIA_TYPES = new Set([3, 34, 43]); // image, voice, video
const CHAT_HISTORY_APPMSG_TYPE = 19;

/** Merged-forward / 聊天记录 cards keep display text; nested media lives on `items`. */
export function isWeChatChatHistoryMessage(msg: {
  type: number;
  content?: string;
  forwarded?: unknown;
}): boolean {
  if (msg.forwarded) return true;
  const content = msg.content ?? "";
  if (content.startsWith("[Chat History]")) return true;
  const baseType = msg.type & 0x7fffffff;
  if (baseType !== 49) return false;
  const packedSubtype = Math.floor(msg.type / 0x1_0000_0000);
  if (packedSubtype === CHAT_HISTORY_APPMSG_TYPE) return true;
  return /<type>\s*19\s*<\/type>/.test(content);
}

export function shouldPollInboundMedia(msg: {
  type: number;
  content?: string;
  forwarded?: unknown;
}): boolean {
  const baseType = msg.type & 0x7fffffff;
  if (DOWNLOADABLE_MEDIA_TYPES.has(baseType)) return true;
  return baseType === 49;
}

type NestedMediaItem = {
  type?: string;
  data?: string;
  format?: string;
  filename?: string;
  source?: string;
  errorCode?: string;
};

export function nestedChatHistoryMedia(
  result: { type?: string; items?: NestedMediaItem[] } | null | undefined,
): Array<NestedMediaItem & { type: string; data: string }> {
  return (result?.items ?? []).filter(
    (item): item is NestedMediaItem & { type: string; data: string } =>
      Boolean(item?.data) && Boolean(item?.type) && item.type !== "unsupported",
  );
}

export function isUnsupportedInboundMedia(
  result: { type?: string } | null | undefined,
): boolean {
  return result?.type === "unsupported";
}

export function mediaFlagsFromPollResult(
  result: { type?: string; data?: string; errorCode?: string; items?: NestedMediaItem[] } | null | undefined,
  baseType: number,
): { hasMedia: boolean; mediaErrorCode?: string } {
  if (nestedChatHistoryMedia(result).length > 0) {
    return { hasMedia: true };
  }
  if (result && result.data && result.type !== "unsupported") {
    return { hasMedia: true };
  }
  if (isUnsupportedInboundMedia(result)) {
    return { hasMedia: false };
  }
  if (result?.errorCode || (result && result.type !== "unsupported") || DOWNLOADABLE_MEDIA_TYPES.has(baseType)) {
    return {
      hasMedia: true,
      mediaErrorCode: result?.errorCode ?? "MEDIA_DOWNLOAD_UNAVAILABLE",
    };
  }
  return { hasMedia: false };
}

type MediaClient = { getMedia(chatId: string, localId: number): Promise<MediaResult> };
type MediaRetryTrigger = (result: MediaResult, attempt: number) => Promise<void>;
type MediaMaterializationClient = {
  openChat(chatId: string, clearUnreads?: boolean, signal?: AbortSignal, executionTimeoutMs?: number): Promise<unknown>;
  downloadFile?(chatId: string, filename?: string, signal?: AbortSignal, executionTimeoutMs?: number): Promise<unknown>;
};
type ImageMaterializationClient = MediaMaterializationClient;


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
// File bubble click is a GUI plan (open chat + click). Do not abort it from the
// plugin poll window; fire-and-forget and keep polling getMedia.
export const FILE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS = IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS;
export const FILE_MATERIALIZATION_CLICK_TIMEOUT_MS = 8_000;

export type MediaMaterializationTriggerOptions = {
  log?: { info?: (...args: any[]) => void };
  timeoutMs?: number;
  // Catch-up processUnreadChat(..., skipOpen=true) must still reopen for type=3
  // and type=49 file attachments. Callers can pass skipOpen without gating the trigger.
  skipOpen?: boolean;
};
export type ImageMaterializationTriggerOptions = MediaMaterializationTriggerOptions;

function shouldTriggerMediaMaterialization(result: MediaResult): boolean {
  return result.type === "image" || result.type === "file" || result.type === "pending";
}

function isFileMaterialization(result: MediaResult): boolean {
  return result.type === "file"
    || result.errorCode === "FILE_NOT_DOWNLOADED"
    || result.errorCode === "FILE_NOT_STABLE";
}

async function triggerImageOpenChat(
  client: MediaMaterializationClient,
  chatId: string,
  timeoutMs: number,
  result: MediaResult,
  attempt: number,
  options?: MediaMaterializationTriggerOptions,
): Promise<void> {
  options?.log?.info?.(
    `[wechat:media] triggering chat reopen for ${result.type} attempt=${attempt} skipOpen=${options?.skipOpen === true}`,
  );
  const controller = new AbortController();
  const opened = Promise.resolve(client.openChat(chatId, true, controller.signal, timeoutMs));
  // Prevent a later overlay timeout from becoming an unhandled rejection after we move on.
  void opened.catch(() => undefined);
  try {
    await raceWithTimeout(opened, timeoutMs);
  } finally {
    controller.abort();
  }
}

function triggerFileBubbleClick(
  client: MediaMaterializationClient,
  chatId: string,
  result: MediaResult,
  attempt: number,
  options?: MediaMaterializationTriggerOptions,
): void {
  const filename = result.filename?.trim() || undefined;
  const timeoutMs = options?.timeoutMs ?? FILE_MATERIALIZATION_CLICK_TIMEOUT_MS;
  options?.log?.info?.(
    `[wechat:media] triggering file bubble click attempt=${attempt} filename=${filename ?? ""} skipOpen=${options?.skipOpen === true}`,
  );
  if (!client.downloadFile) {
    throw Object.assign(new Error("FILE_DOWNLOAD_TRIGGER_UNAVAILABLE"), {
      code: "FILE_DOWNLOAD_TRIGGER_UNAVAILABLE",
    });
  }
  // Do not abort: HTTP abort must not cancel the overlay click. Poll getMedia instead.
  const clicked = Promise.resolve(client.downloadFile(chatId, filename, undefined, timeoutMs));
  void clicked.catch(() => undefined);
}

export function createMediaMaterializationTrigger(
  client: MediaMaterializationClient,
  chatId: string,
  options?: MediaMaterializationTriggerOptions,
): MediaRetryTrigger {
  const timeoutMs = options?.timeoutMs ?? IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS;
  return async (result, attempt) => {
    if (!shouldTriggerMediaMaterialization(result)) return;
    if (isFileMaterialization(result)) {
      triggerFileBubbleClick(client, chatId, result, attempt, options);
      return;
    }
    await triggerImageOpenChat(client, chatId, timeoutMs, result, attempt, options);
  };
}

export function createImageMaterializationTrigger(
  client: ImageMaterializationClient,
  chatId: string,
  options?: ImageMaterializationTriggerOptions,
): MediaRetryTrigger {
  const timeoutMs = options?.timeoutMs ?? IMAGE_MATERIALIZATION_OPEN_CHAT_TIMEOUT_MS;
  return async (result, attempt) => {
    if (!shouldTriggerMediaMaterialization(result)) return;
    if (isFileMaterialization(result)) {
      triggerFileBubbleClick(client, chatId, result, attempt, options);
      return;
    }
    await triggerImageOpenChat(client, chatId, timeoutMs, result, attempt, options);
  };
}

export function mediaMaterializationTriggerForMessage(opts: {
  client: MediaMaterializationClient;
  chatId: string;
  messageType: number;
  log?: { info?: (...args: any[]) => void };
  timeoutMs?: number;
  skipOpen?: boolean;
}): MediaRetryTrigger | undefined {
  const baseType = opts.messageType & 0x7fffffff;
  // type=3 images; type=49 appmsg files (server returns type=file for subtype 6).
  // Chat history still polls getMedia for nested items, but never materializes via overlay.
  if (baseType !== 3 && baseType !== 49) return undefined;
  return createMediaMaterializationTrigger(opts.client, opts.chatId, {
    log: opts.log,
    timeoutMs: opts.timeoutMs,
    skipOpen: opts.skipOpen,
  });
}

export function imageMaterializationTriggerForMessage(opts: {
  client: ImageMaterializationClient;
  chatId: string;
  messageType: number;
  log?: { info?: (...args: any[]) => void };
  timeoutMs?: number;
  skipOpen?: boolean;
}): MediaRetryTrigger | undefined {
  return mediaMaterializationTriggerForMessage(opts);
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
