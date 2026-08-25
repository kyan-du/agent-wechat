import { chatSyncPageSchema, groupMembersPageSchema, sendParamsSchema, sendResultSchema } from "./schemas/index.js";
import type {
  Chat,
  Contact,
  GroupMember,
  Message,
  SendResult,
  MediaResult,
  ChatSyncPage,
  LoginResult,
  LoginSubscriptionEvent,
  OpenChatResult,
  SendParams,
} from "./types/index.js";

// Re-export Status/LoginState types used by the client
export type LoginState = { status: string };
export type StatusResponse = {
  container: string;
  loginState: LoginState;
  version: string;
  apiVersion: number;
};
export type CursorPage<T> = {
  schemaVersion: 1;
  items: T[];
  nextCursor?: string;
  errorCode?: string;
};

export type AuthStatus = {
  status: "logged_in" | "logged_out" | "app_not_running" | "unknown";
  loggedInUser?: string;
};

export interface WeChatClientOptions {
  baseUrl: string;
  token?: string;
  headers?: Record<string, string>;
}

export class WeChatHttpError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly retryAfter?: number;

  constructor(
    status: number,
    statusText: string,
    body: string,
    errorCode?: string,
    retryAfter?: number,
  ) {
    super(
      errorCode
        ? `${status} ${statusText}: ${errorCode}`
        : `${status} ${statusText}: ${body}`,
    );
    this.name = "WeChatHttpError";
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function throwHttpError(res: Response): Promise<never> {
  const body = await res.text();
  let errorCode: string | undefined;
  try {
    const parsed = JSON.parse(body) as { errorCode?: unknown };
    if (typeof parsed.errorCode === "string") {
      errorCode = parsed.errorCode;
    }
  } catch {
    // Non-JSON error bodies stay generic.
  }
  throw new WeChatHttpError(
    res.status,
    res.statusText,
    body,
    errorCode,
    parseRetryAfter(res.headers.get("retry-after")),
  );
}

function normalizeUrl(base: string): string {
  const url = base.startsWith("http") ? base : `http://${base}`;
  return url.replace(/\/$/, "");
}

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join("&")
  );
}

export class WeChatClient {
  private base: string;
  private headers: Record<string, string>;

  constructor(options: WeChatClientOptions) {
    this.base = normalizeUrl(options.baseUrl);
    this.headers = { "Content-Type": "application/json" };
    if (options.token) this.headers.Authorization = `Bearer ${options.token}`;
    if (options.headers) Object.assign(this.headers, options.headers);
  }

  /** Get the base URL (for WebSocket URL derivation, etc.) */
  get baseUrl(): string {
    return this.base;
  }

  // ---- internal helpers ----

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: this.headers,
    });
    if (!res.ok) await throwHttpError(res);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) await throwHttpError(res);
    return res.json() as Promise<T>;
  }

  // ---- Status ----

  async status(): Promise<StatusResponse> {
    return this.get("/api/status");
  }

  async loginState(): Promise<LoginState> {
    const s = await this.status();
    return s.loginState;
  }

  async authStatus(): Promise<AuthStatus> {
    return this.get("/api/status/auth");
  }

  async login(): Promise<LoginResult> {
    return this.post("/api/status/login");
  }

  async logout(): Promise<{ success: boolean; error?: string }> {
    return this.post("/api/status/logout");
  }

  async resetAuth(): Promise<{ success: boolean; errorCode?: string; error?: string }> {
    return this.post("/api/status/auth/reset");
  }

  // ---- Chats ----

  async listChatsPage(
    limit?: number,
    cursor?: string,
    unreadOnly?: boolean,
  ): Promise<CursorPage<Chat>> {
    const page = await this.get<CursorPage<Chat>>(`/api/chats${qs({ limit, cursor, unreadOnly })}`);
    if (page.errorCode) throw new WeChatHttpError(400, "Bad Request", page.errorCode, page.errorCode);
    return page;
  }

  async listChats(limit?: number): Promise<Chat[]> {
    return (await this.listChatsPage(limit)).items;
  }

  async getChat(id: string): Promise<Chat | null> {
    return this.get(`/api/chats/${encodeURIComponent(id)}`);
  }

  async findChats(name: string): Promise<Chat[]> {
    return this.get(`/api/chats/find${qs({ name })}`);
  }

  async markChatRead(chatId: string): Promise<OpenChatResult & { beforeUnread?: number; afterUnread?: number }> {
    return this.post(`/api/chats/${encodeURIComponent(chatId)}/mark-read`);
  }

  async openChat(
    chatId: string,
    clearUnreads?: boolean,
  ): Promise<OpenChatResult> {
    return this.post(
      `/api/chats/${encodeURIComponent(chatId)}/open${qs({ clearUnreads })}`,
    );
  }

  async listGroupMembersPage(
    groupId: string,
    limit?: number,
    cursor?: string,
  ): Promise<CursorPage<GroupMember>> {
    const page = groupMembersPageSchema.parse(await this.get<unknown>(
      `/api/groups/${encodeURIComponent(groupId)}/members${qs({ limit, cursor })}`,
    ));
    if (page.errorCode) throw new WeChatHttpError(400, "Bad Request", page.errorCode, page.errorCode);
    return { ...page, nextCursor: page.nextCursor ?? undefined };
  }

  // ---- Contacts ----

  async listContactsPage(limit?: number, cursor?: string): Promise<CursorPage<Contact>> {
    const page = await this.get<CursorPage<Contact>>(`/api/contacts${qs({ limit, cursor })}`);
    if (page.errorCode) throw new WeChatHttpError(400, "Bad Request", page.errorCode, page.errorCode);
    return page;
  }

  async listContacts(limit?: number): Promise<Contact[]> {
    return (await this.listContactsPage(limit)).items;
  }

  async findContacts(name: string): Promise<Contact[]> {
    return this.get(`/api/contacts/find${qs({ name })}`);
  }

  // ---- Messages ----

  async listMessagesPage(
    chatId: string,
    limit?: number,
    cursor?: string,
  ): Promise<CursorPage<Message>> {
    const page = await this.get<CursorPage<Message>>(
      `/api/messages/${encodeURIComponent(chatId)}${qs({ limit, cursor })}`,
    );
    if (page.errorCode) throw new WeChatHttpError(400, "Bad Request", page.errorCode, page.errorCode);
    return page;
  }

  async listMessages(chatId: string, limit?: number): Promise<Message[]> {
    return (await this.listMessagesPage(chatId, limit)).items;
  }

  async syncChat(
    chatId: string,
    options: { limit?: number; cursor?: string; since?: string; from?: string; to?: string } = {},
  ): Promise<ChatSyncPage> {
    const raw = await this.get<unknown>(
      `/api/sync/${encodeURIComponent(chatId)}${qs({ limit: options.limit, cursor: options.cursor, since: options.since, from: options.from, to: options.to })}`,
    );
    if (raw && typeof raw === "object" && typeof (raw as { errorCode?: unknown }).errorCode === "string") {
      const errorCode = (raw as { errorCode: string }).errorCode;
      throw new WeChatHttpError(400, "Bad Request", errorCode, errorCode);
    }
    const page = chatSyncPageSchema.parse(raw);
    if (page.errorCode) throw new WeChatHttpError(400, "Bad Request", page.errorCode, page.errorCode);
    return { ...page, nextCursor: page.nextCursor ?? undefined };
  }

  async getMedia(
    chatId: string,
    localId: number,
  ): Promise<MediaResult> {
    return this.get(
      `/api/messages/${encodeURIComponent(chatId)}/media/${localId}`,
    );
  }

  async sendMessage(params: SendParams): Promise<SendResult> {
    const validated = sendParamsSchema.parse(params);
    const res = await fetch(`${this.base}/api/messages/send`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(validated),
    });
    if (res.ok) return sendResultSchema.parse(await res.json());

    const body = await res.text();
    if (res.status === 409) {
      try {
        const result = sendResultSchema.parse(JSON.parse(body));
        if (
          result.success === false &&
          result.errorCode === "SIMILAR_CONTENT_CONFIRMATION_REQUIRED"
        ) {
          return result;
        }
      } catch {
        // Preserve the ordinary HTTP error contract for malformed responses.
      }
    }
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(body) as { errorCode?: unknown };
      if (typeof parsed.errorCode === "string") errorCode = parsed.errorCode;
    } catch {
      // Non-JSON error bodies stay generic.
    }
    throw new WeChatHttpError(
      res.status,
      res.statusText,
      body,
      errorCode,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  // ---- Debug ----

  async screenshot(): Promise<{ base64: string }> {
    return this.get("/api/debug/screenshot");
  }

  async a11y(
    format: "json" | "aria",
  ): Promise<{ tree: unknown; aria: string | null; error?: string }> {
    return this.get(`/api/debug/a11y${qs({ format })}`);
  }

  // ---- Sessions ----

  // ---- Login subscription (WebSocket) ----

  /**
   * Subscribe to login events via WebSocket.
   * Uses the native WebSocket API (Node 22+).
   * Returns a handle with close() to tear down the connection.
   */
  /** Extract the bearer token (if any) for use in WebSocket query params. */
  private get wsToken(): string | undefined {
    const auth = this.headers.Authorization;
    return auth?.replace(/^Bearer\s+/i, "");
  }

  loginSubscribe(opts: {
    timeoutMs?: number;
    newAccount?: boolean;
    onEvent: (event: LoginSubscriptionEvent) => void;
    onError?: (err: Error) => void;
    onClose?: () => void;
  }): { close: () => void } {
    const wsUrl = this.base.replace(/^http/, "ws");
    const params = qs({
      timeoutMs: opts.timeoutMs,
      newAccount: opts.newAccount,
      token: this.wsToken,
    });
    const ws = new WebSocket(`${wsUrl}/api/ws/login${params}`);

    ws.addEventListener("message", (event) => {
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : String(event.data);
        const parsed = JSON.parse(data) as LoginSubscriptionEvent;
        opts.onEvent(parsed);
      } catch (e) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    ws.addEventListener("error", (event) => {
      const msg =
        "message" in event && typeof (event as any).message === "string"
          ? (event as any).message
          : "WebSocket error";
      opts.onError?.(new Error(msg));
    });

    ws.addEventListener("close", () => {
      opts.onClose?.();
    });

    return {
      close: () => {
        ws.close();
      },
    };
  }
}
