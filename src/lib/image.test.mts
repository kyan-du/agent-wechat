import assert from "node:assert/strict";
import test from "node:test";
import { localBuildImage, validateImageReference } from "./image.ts";

test("default image is the local architecture build", () => {
  assert.equal(localBuildImage("darwin", "arm64"), "agent-wechat:arm64");
  assert.equal(localBuildImage("linux", "x64"), "agent-wechat:amd64");
});

test("accepts local images and explicit immutable release selections", () => {
  assert.equal(validateImageReference("agent-wechat:arm64"), "agent-wechat:arm64");
  assert.equal(validateImageReference("ghcr.io/kyan-du/agent-wechat:1.2.3"), "ghcr.io/kyan-du/agent-wechat:1.2.3");
  const digest = `ghcr.io/kyan-du/agent-wechat@sha256:${"a".repeat(64)}`;
  assert.equal(validateImageReference(digest), digest);
});

test("rejects dead defaults, latest, foreign, placeholders, and shell-like values", () => {
  for (const reference of [
    "ghcr.io/kyan-du/agent-wechat:latest",
    "ghcr.io/other/image:1.2.3",
    "ghcr.io/kyan-du/agent-wechat:<version>",
    "agent-wechat:arm64;echo pwned",
  ]) {
    assert.throws(() => validateImageReference(reference), /Invalid image reference/);
  }
});
