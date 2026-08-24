import { WeChatHttpError } from "@kyan-du/agent-wechat-shared";

export function hasExplicitGroupMemberConsent(params: Record<string, unknown>): boolean {
  return params.confirmed === true;
}

export function groupMemberErrorCode(error: unknown): string {
  return error instanceof WeChatHttpError && error.errorCode
    ? error.errorCode
    : "GROUP_MEMBERS_FAILED";
}
