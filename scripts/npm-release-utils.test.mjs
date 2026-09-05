#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyNpmFailure,
  exactStableVersionPattern,
  publicPackages,
  retryTransient,
  verifyTarballIntegrity,
} from "./npm-release-utils.mjs";

test("exactStableVersionPattern accepts 0.14.1 and rejects YAML-escaped digit class", () => {
  assert.equal(exactStableVersionPattern.test("0.14.1"), true);
  assert.equal(exactStableVersionPattern.test("0.14.1-next.1"), false);
  const yamlEscaped = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/;
  assert.equal(yamlEscaped.test("0.14.1"), false);
});

test("classifies npm propagation and network errors as transient", () => {
  for (const stderr of [
    "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@scope%2fpkg - Not found",
    "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for @scope/pkg@1.2.3.",
    "npm ERR! code ECONNRESET\nnpm ERR! network socket hang up",
    "npm ERR! code ETIMEDOUT\nnpm ERR! network timeout",
    "npm ERR! code E503\nnpm ERR! 503 Service Unavailable",
  ]) {
    assert.equal(classifyNpmFailure({ stderr }).transient, true, stderr);
  }
});

test("classifies npm 11 CI E404 wording as transient", () => {
  const ci = classifyNpmFailure({
    stderr: "npm error code E404\nnpm error 404 No match found for version 0.14.0",
  });
  assert.equal(ci.code, "E404");
  assert.equal(ci.transient, true);

  const json = classifyNpmFailure({
    stdout: '{"error":{"code":"E404","summary":"No match found for version 0.14.0"}}',
  });
  assert.equal(json.code, "E404");
  assert.equal(json.transient, true);
});

test("classifies existing-version publish rejection for reconciliation", () => {
  const failure = classifyNpmFailure({
    stderr: "npm ERR! code E403\nnpm ERR! 403 You cannot publish over the previously published versions: 1.2.3.",
  });
  assert.equal(failure.alreadyExists, true);
  assert.equal(failure.transient, false);
});

test("classifies auth failures as non-transient", () => {
  const failure = classifyNpmFailure({ stderr: "npm ERR! code E401\nnpm ERR! Incorrect or missing password." });
  assert.equal(failure.transient, false);
  assert.equal(failure.alreadyExists, false);
});

test("retryTransient retries bounded transient failures then succeeds", async () => {
  const attempts = [];
  const result = await retryTransient(
    "npm view @scope/pkg@1.2.3",
    (attempt) => {
      attempts.push(attempt);
      return attempt < 3
        ? { ok: false, stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found" }
        : { ok: true, stdout: "{\"ok\":true}" };
    },
    { attempts: 4, initialDelayMs: 1, maxDelayMs: 1 },
  );
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(result.ok, true);
});

test("retryTransient fails immediately on non-transient errors", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransient(
      "npm view @scope/pkg@1.2.3",
      () => {
        attempts += 1;
        return { ok: false, stderr: "npm ERR! code E401\nnpm ERR! auth required" };
      },
      { attempts: 4, initialDelayMs: 1, maxDelayMs: 1 },
    ),
    /non-transient npm error E401/,
  );
  assert.equal(attempts, 1);
});

test("local candidate tarball integrity must match registry metadata before skipping publish", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-release-utils-test-"));
  try {
    const tarball = join(dir, "candidate.tgz");
    writeFileSync(tarball, "candidate");
    const integrity = `sha512-${createHash("sha512").update("candidate").digest("base64")}`;
    assert.equal(verifyTarballIntegrity(tarball, { name: "@scope/pkg", version: "1.2.3", dist: { integrity } }), integrity);
    assert.throws(
      () => verifyTarballIntegrity(tarball, { name: "@scope/pkg", version: "1.2.3", dist: { integrity: "sha512-different" } }),
      /different content/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production package set stays exact", () => {
  assert.deepEqual(publicPackages.map((item) => item.name), [
    "@kyan-du/agent-wechat-cli",
    "@kyan-du/agent-wechat-openclaw",
    "@kyan-du/agent-wechat-wechaty-puppet",
  ]);
});
