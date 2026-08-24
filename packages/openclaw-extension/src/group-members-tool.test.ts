import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitGroupMemberConsent } from "./group-members-consent.ts";

test("group member tool requires explicit confirmation", () => {
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom", confirmed: false }), false);
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom", confirmed: true }), true);
  assert.equal(hasExplicitGroupMemberConsent({ groupId: "room@chatroom" }), false);
});
