import assert from "node:assert/strict";
import test from "node:test";
import { classifyNpmView } from "./verify-npm-versions-absent.mjs";

const spec = "@kyan-du/agent-wechat-cli@1.2.3";
test("existing package query is classified as existing", () => assert.equal(classifyNpmView({ status: 0, stdout: JSON.stringify({ version: "1.2.3", "dist.integrity": "sha512-ok" }), stderr: "" }, spec).kind, "exists"));
test("exact structured package-specific E404 remains the only absent signal", () => {
  const stdout = JSON.stringify({ error: { code: "E404", detail: `${spec} is not in this registry`, summary: "Not Found" } });
  assert.equal(classifyNpmView({ status: 1, stdout, stderr: "" }, spec).kind, "absent");
});
for (const [label, result] of [
  ["malformed", { status: 1, stdout: "404", stderr: "" }],
  ["auth", { status: 1, stdout: JSON.stringify({ error: { code: "E401", detail: spec } }), stderr: "" }],
  ["wrong package", { status: 1, stdout: JSON.stringify({ error: { code: "E404", detail: "other is not in this registry" } }), stderr: "" }],
]) test(`${label} is not safe absence`, () => assert.equal(classifyNpmView(result, spec).kind, "error"));
