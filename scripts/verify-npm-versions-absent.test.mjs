#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { classifyNpmView, packages, verifyVersionsAbsent } from "./verify-npm-versions-absent.mjs";

const spec = `${packages[0]}@9.9.9-next.1`;

test("structured package-specific E404 is absent", () => {
  const result = classifyNpmView({
    status: 1,
    stdout: "",
    stderr: `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${encodeURIComponent(spec)} - ${spec} is not in this registry`,
  }, spec);
  assert.equal(result.kind, "absent");
});

for (const [label, stderr] of [
  ["auth", "npm error code E401"],
  ["rate limit", "npm error code E429"],
  ["server", "npm error code E500"],
  ["network", "npm error code EAI_AGAIN"],
  ["wrong package 404", "npm error code E404 npm error 404 Not Found other@9.9.9-next.1 is not in this registry"],
]) {
  test(`${label} errors fail closed`, () => {
    assert.equal(classifyNpmView({ status: 1, stdout: "", stderr }, spec).kind, "error");
  });
}

test("all three packages are checked before success", () => {
  const calls = [];
  const results = verifyVersionsAbsent("9.9.9-next.1", (_command, args) => {
    calls.push(args[1]);
    return {
      status: 1,
      stdout: "",
      stderr: `npm error code E404 npm error 404 Not Found ${args[1]} is not in this registry`,
    };
  });
  assert.equal(results.length, 3);
  assert.equal(calls.length, 3);
});

test("network failure aborts the complete preflight", () => {
  assert.throws(
    () => verifyVersionsAbsent("9.9.9-next.1", () => ({ status: 1, stdout: "", stderr: "EAI_AGAIN" })),
    /failed closed/,
  );
});
