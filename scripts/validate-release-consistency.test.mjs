#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseVersions } from "./validate-release-consistency.mjs";

test("release versions must agree across all package manifests", () => {
  const files = {
    npm: [
      { name: "@kyan-du/agent-wechat-cli", version: "0.13.4" },
      { name: "@kyan-du/agent-wechat-openclaw", version: "0.13.4" },
      { name: "@kyan-du/agent-wechat-wechaty-puppet", version: "0.13.3" },
    ],
    cargo: "0.13.4",
    cli: "0.13.4",
  };
  assert.throws(
    () => validateReleaseVersions(files, "0.13.4"),
    /wechaty-puppet.*0\.13\.3.*0\.13\.4/,
  );
});

test("release versions accept matching npm, Cargo, and CLI metadata", () => {
  const files = {
    npm: [
      { name: "@kyan-du/agent-wechat-cli", version: "0.13.4" },
      { name: "@kyan-du/agent-wechat-openclaw", version: "0.13.4" },
      { name: "@kyan-du/agent-wechat-wechaty-puppet", version: "0.13.4" },
    ],
    cargo: "0.13.4",
    cli: "0.13.4",
  };
  assert.equal(validateReleaseVersions(files, "0.13.4"), true);
});

console.log("release consistency tests passed");
