import assert from "node:assert/strict";
import test from "node:test";
import { WeChatHttpError } from "@kyan-du/agent-wechat-shared";
import { groupMemberErrorCode, hasExplicitGroupMemberConsent } from "./group-members-consent.ts";

test("group member tool requires explicit confirmation", () => {
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom", confirmed: false }), false);
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom", confirmed: true }), true);
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom" }), false);
});

test("group member tool preserves stable API diagnostics", () => {
  const error = new WeChatHttpError(403, "Forbidden", "GROUP_NOT_JOINED", "GROUP_NOT_JOINED");
  assert.equal(groupMemberErrorCode(error), "GROUP_NOT_JOINED");
  assert.equal(groupMemberErrorCode(new Error("boom")), "GROUP_MEMBERS_FAILED");
});
