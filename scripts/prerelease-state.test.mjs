import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prereleaseEnterRequired } from "./prerelease-state.mjs";

const dir = mkdtempSync(join(tmpdir(), "prerelease-state-test-"));

test("fresh checkout requires entering prerelease mode", () => {
  assert.equal(prereleaseEnterRequired(join(dir, "missing.json"), "next"), true);
});

test("existing next prerelease mode is reentrant", () => {
  const path = join(dir, "next.json");
  writeFileSync(path, JSON.stringify({ mode: "pre", tag: "next", initialVersions: {}, changesets: [] }));
  assert.equal(prereleaseEnterRequired(path, "next"), false);
});

test("wrong prerelease tag fails closed", () => {
  const path = join(dir, "wrong.json");
  writeFileSync(path, JSON.stringify({ mode: "pre", tag: "beta", initialVersions: {}, changesets: [] }));
  assert.throws(() => prereleaseEnterRequired(path, "next"), /must be pre\/next; found pre\/beta/);
});

test("malformed prerelease state fails closed", () => {
  const path = join(dir, "malformed.json");
  writeFileSync(path, JSON.stringify({ mode: "pre", tag: "next" }));
  assert.throws(() => prereleaseEnterRequired(path, "next"), /state is incomplete/);
});
