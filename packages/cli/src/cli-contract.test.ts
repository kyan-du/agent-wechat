import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve(import.meta.dirname, "../dist/cli.js");
if (!fs.existsSync(cli)) {
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../build.js")], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: "inherit",
  });
}

function run(args: string[], home = fs.mkdtempSync(path.join(os.tmpdir(), "wx-cli-"))) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("public help is the clean single-instance surface", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  for (const command of ["start", "stop", "restart", "status", "doctor", "auth", "chats", "contacts", "messages", "send", "upgrade"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, /^  (?:up|down|update|session|dev)\b/m);
});

test("legacy commands are guidance-only nonzero exits", () => {
  for (const [oldName, replacement] of [["up", "start"], ["down", "stop"], ["update", "dev sync-server"], ["session", "single-instance"]]) {
    const result = run([oldName]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(replacement));
  }
});

test("JSON mode emits one envelope and no diagnostics on stdout", () => {
  const result = run(["--json", "send", "wxid_a"]);
  assert.equal(result.status, 2);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const value = JSON.parse(lines[0]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.ok, false);
  assert.equal(value.code, "INVALID_ARGUMENT");
  assert.equal(result.stderr, "");
});

test("send requires a target and one payload before contacting service", () => {
  assert.notEqual(run(["send", "--text", "hello"]).status, 0);
  const missing = run(["--json", "send", "wxid_a"]);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).code, "INVALID_ARGUMENT");
  const duplicate = run(["--json", "send", "wxid_a", "--text", "x", "--file", import.meta.filename]);
  assert.equal(duplicate.status, 2);
  assert.match(JSON.parse(duplicate.stdout).error, /exactly one/);
});

test("group members command is explicit, paginated, and read-only", () => {
  const result = run(["chats", "members", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bounded page of group members read-only/);
  assert.match(result.stdout, /--limit/);
  assert.match(result.stdout, /--cursor/);
});

test("packed CLI can run without a workspace checkout", () => {
  assert.equal(fs.existsSync(cli), true, "build the CLI before this test");
  const result = run(["messages", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /opaque next-page cursor/);
});
