import type { ResolvedWeChatAccount } from "./types.js";
import { WeChatClient } from "@kyan-du/agent-wechat-shared";
import { loginStart, getActiveLoginState } from "./login.js";
import { buildOpenClawConfirmedSend } from "./confirmed-send.js";
import { groupMemberErrorCode, hasExplicitGroupMemberConsent } from "./group-members-consent.js";

export function createWeChatConfirmedSendTool(account: ResolvedWeChatAccount) {
  const client = new WeChatClient({
    baseUrl: account.serverUrl,
    token: account.token,
  });

  return {
    label: "WeChat Confirmed Send",
    name: "wechat_send_confirmed",
    description:
      "Send one operator-reviewed text after a SIMILAR_CONTENT_CONFIRMATION_REQUIRED warning. Use only after the user explicitly confirms the exact recipient and text; never call automatically.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        chatId: { type: "string" },
        text: { type: "string" },
        confirmed: {
          type: "boolean",
          description: "Must be true only after explicit operator confirmation.",
        },
      },
      required: ["chatId", "text", "confirmed"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const sendParams = buildOpenClawConfirmedSend({
        chatId: String(args.chatId ?? ""),
        text: String(args.text ?? ""),
        confirmed: args.confirmed === true,
      });
      if (!sendParams) {
        return {
          content: [{ type: "text" as const, text: "Explicit operator confirmation is required." }],
          details: { success: false, errorCode: "EXPLICIT_CONFIRMATION_REQUIRED" },
        };
      }
      const result = await client.sendMessage(sendParams);
      return {
        content: [{
          type: "text" as const,
          text: result.success ? "Confirmed WeChat message sent." : (result.error ?? "Send failed"),
        }],
        details: result,
      };
    },
  };
}

export function createWeChatGroupMembersTool(account: ResolvedWeChatAccount) {
  const client = new WeChatClient({ baseUrl: account.serverUrl, token: account.token });
  return {
    label: "WeChat Group Members",
    name: "wechat_group_members",
    description: "Read one bounded page of group members by stable group id. This returns personal information; call only when the user explicitly asks for a specific group, and do not echo more fields than needed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupId: { type: "string", description: "Stable group id ending in @chatroom" },
        limit: { type: "number", minimum: 1, maximum: 50 },
        cursor: { type: "string" },
        confirmed: { type: "boolean", description: "Must be true after the user explicitly requests this group's personal member data." },
      },
      required: ["groupId", "confirmed"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const groupId = String(args.groupId ?? "").trim();
      if (!hasExplicitGroupMemberConsent(args)) {
        return {
          content: [{ type: "text" as const, text: "Explicit user confirmation is required before reading group member personal data." }],
          details: { success: false, errorCode: "EXPLICIT_CONFIRMATION_REQUIRED" },
        };
      }
      const limit = typeof args.limit === "number" ? Math.trunc(args.limit) : 25;
      try {
        const page = await client.listGroupMembersPage(
          groupId,
          Math.min(50, Math.max(1, limit)),
          typeof args.cursor === "string" ? args.cursor : undefined,
        );
        return {
          content: [{ type: "text" as const, text: `Retrieved ${page.items.length} group member(s).` }],
          details: page,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: "Group member lookup failed." }],
          details: { error: true, code: groupMemberErrorCode(error) },
        };
      }
    },
  };
}

export function createWeChatLoginTool(account: ResolvedWeChatAccount) {
  const client = new WeChatClient({
    baseUrl: account.serverUrl,
    token: account.token,
  });

  return {
    label: "WeChat Login",
    name: "wechat_login",
    description:
      "Check WeChat login status, start a login session, or log out. Calling start again returns the latest state from the existing session. When start returns qrData, generate a QR code image from it and show it to the user so they can scan it with their phone.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "logout", "status"],
        },
        force: {
          type: "boolean",
          description:
            "Log in with a new account (shows QR code even if already logged in)",
        },
        timeoutMs: { type: "number" },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as Record<string, unknown>;
      const action = args.action as "start" | "logout" | "status";
      const force = args.force as boolean | undefined;
      const timeoutMs = args.timeoutMs as number | undefined;

      switch (action) {
        case "status": {
          try {
            const auth = await client.authStatus();
            const text = auth.status === "logged_in"
              ? `WeChat is logged in${auth.loggedInUser ? ` as ${auth.loggedInUser}` : ""}.`
              : `WeChat status: ${auth.status.replace(/_/g, " ")}.`;
            return {
              content: [{ type: "text" as const, text }],
              details: auth,
            };
          } catch (err) {
            const text = `Failed to check WeChat status: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }

        case "start": {
          // Check for existing active login session
          const existing = getActiveLoginState(account.accountId);
          if (existing.active && !force) {
            if (existing.done && existing.connected) {
              return {
                content: [
                  { type: "text" as const, text: "Login successful." },
                ],
                details: { state: "done", connected: true },
              };
            }
            if (existing.done) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      existing.error ??
                      existing.message ??
                      "Login session ended.",
                  },
                ],
                details: {
                  state: "done",
                  connected: false,
                  error: existing.error,
                },
              };
            }
            // Still in progress — return cached state
            const parts: string[] = [];
            if (existing.message) parts.push(existing.message);
            if (existing.qrData)
              parts.push(`QR data: ${existing.qrData}`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: parts.join("\n") || "Login in progress...",
                },
              ],
              details: {
                state: existing.qrData ? "qr" : "waiting",
                qrData: existing.qrData,
              },
            };
          }

          // Start a new login session
          try {
            const result = await loginStart(client, account.accountId, {
              timeoutMs,
              force,
            });
            // After loginStart resolves, check state for qrData
            const state = getActiveLoginState(account.accountId);
            if (state.qrData) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${result.message}\nQR data: ${state.qrData}`,
                  },
                ],
                details: { state: "qr", qrData: state.qrData },
              };
            }
            return {
              content: [
                { type: "text" as const, text: result.message },
              ],
              details: { state: "waiting" },
            };
          } catch (err) {
            const text = `Failed to start WeChat login: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }

        case "logout": {
          try {
            const result = await client.logout();
            const text = result.success
              ? "WeChat logged out successfully."
              : `WeChat logout failed${result.error ? `: ${result.error}` : ""}.`;
            return {
              content: [{ type: "text" as const, text }],
              details: result,
            };
          } catch (err) {
            const text = `Failed to log out of WeChat: ${err instanceof Error ? err.message : String(err)}`;
            return {
              content: [{ type: "text" as const, text }],
              details: { error: true },
            };
          }
        }
      }
    },
  };
}
