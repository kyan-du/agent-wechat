#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { root, strictJson } from "./agent-release-lib.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

const index = process.argv.indexOf("--manifest");
if (index < 0 || !process.argv[index + 1]) throw new Error("usage: smoke-published-npm-release.mjs --manifest <path>");
const manifest = verifyReleaseManifest(strictJson(readFileSync(resolve(root, process.argv[index + 1]), "utf8"), "release manifest"));
const dir = mkdtempSync(join(tmpdir(), "agent-wechat-registry-smoke-"));
try {
  const run = (command, args) => execFileSync(command, args, { cwd: dir, stdio: "inherit" });
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...manifest.packages.map((item) => `${item.name}@${item.version}`)]);
  run("node", [join(dir, "node_modules/.bin/wx"), "--version"]);
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "openclaw@^2026.5.12", "wechaty-puppet@^1.10.2"]);
  run("node", ["--input-type=module", "-e", "await Promise.all([import('@kyan-du/agent-wechat-openclaw'), import('@kyan-du/agent-wechat-wechaty-puppet')])"]);
  console.log(`public registry smoke passed for ${manifest.version}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
