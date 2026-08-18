#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "stable-candidate-fixture-"));
const one = mkdtempSync(join(tmpdir(), "stable-candidate-one-"));
const two = mkdtempSync(join(tmpdir(), "stable-candidate-two-"));
const run = (command, args, cwd = fixture, capture = false) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
try {
  run("git", ["clone", "--quiet", "--no-local", source, fixture], source);
  run("git", ["checkout", "--quiet", "HEAD"]);
  for (const path of ["packages/cli/package.json", "packages/openclaw-extension/package.json", "packages/wechaty-puppet/package.json"]) {
    const full = join(fixture, path), manifest = JSON.parse(readFileSync(full, "utf8"));
    manifest.version = "9.8.7"; writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  run("git", ["add", "packages/cli/package.json", "packages/openclaw-extension/package.json", "packages/wechaty-puppet/package.json"]);
  run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "stable fixture"]);
  const commit = run("git", ["rev-parse", "HEAD"], fixture, true).trim();
  run("pnpm", ["install", "--frozen-lockfile"]);
  mkdirSync(join(one, "tarballs")); mkdirSync(join(two, "tarballs"));
  run("node", ["scripts/prepare-agent-release.mjs", "--output", join(one, "manifest.json"), "--artifacts", join(one, "tarballs")]);
  run("node", ["scripts/prepare-agent-release.mjs", "--output", join(two, "manifest.json"), "--artifacts", join(two, "tarballs")]);
  assert.deepEqual(readFileSync(join(one, "manifest.json")), readFileSync(join(two, "manifest.json")));
  const filenames = readdirSync(join(one, "tarballs")).sort();
  assert.deepEqual(filenames, readdirSync(join(two, "tarballs")).sort()); assert.equal(filenames.length, 3);
  for (const filename of filenames) assert.deepEqual(readFileSync(join(one, "tarballs", filename)), readFileSync(join(two, "tarballs", filename)));
  const manifest = JSON.parse(readFileSync(join(one, "manifest.json")));
  assert.equal(manifest.version, "9.8.7"); assert.equal(manifest.commit, commit); assert.equal(manifest.distTag, "latest");
  assert.match(`npm-production-${manifest.version}-${manifest.commit}-${"a".repeat(64)}`, /^npm-production-9\.8\.7-[0-9a-f]{40}-[0-9a-f]{64}$/);
  console.log("side-effect-free stable candidate fixture is byte-deterministic with exact artifact layout/identity");
} finally {
  rmSync(fixture, { recursive: true, force: true }); rmSync(one, { recursive: true, force: true }); rmSync(two, { recursive: true, force: true });
}
