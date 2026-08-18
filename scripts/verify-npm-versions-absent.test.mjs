#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { classifyNpmView, packages, verifyVersionsAbsent } from "./verify-npm-versions-absent.mjs";

const spec = `${packages[0]}@9.9.9-next.1`;
function npmJson(code, detail, summary = "Not Found") {
  return JSON.stringify({ error: { code, summary, detail } });
}

test("npm 10/11 structured stdout E404 is absent", () => {
  const result = classifyNpmView({
    status: 1,
    stdout: npmJson("E404", `404 Not Found - GET registry - ${spec} is not in this registry.`),
    stderr: "npm error code E404\nnpm error 404 Not Found",
  }, spec);
  assert.equal(result.kind, "absent");
});

for (const [label, stdout, stderr = ""] of [
  ["auth", npmJson("E401", "authentication required")],
  ["rate limit", npmJson("E429", "too many requests")],
  ["server", npmJson("E500", "server error")],
  ["network", "", "npm error code EAI_AGAIN"],
  ["malformed", "{not-json"],
  ["wrong package 404", npmJson("E404", "other@9.9.9-next.1 is not in this registry")],
  ["generic stderr-only 404", "", `npm error E404 ${spec} is not in this registry`],
]) {
  test(`${label} errors fail closed`, () => {
    assert.equal(classifyNpmView({ status: 1, stdout, stderr }, spec).kind, "error");
  });
}

test("all three packages are checked before success", () => {
  const calls = [];
  const results = verifyVersionsAbsent("9.9.9-next.1", (_command, args) => {
    calls.push(args[1]);
    return {
      status: 1,
      stdout: npmJson("E404", `${args[1]} is not in this registry`),
      stderr: "npm error code E404",
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
