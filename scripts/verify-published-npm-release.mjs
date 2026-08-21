#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2];
const packages = ["@agent-wechat/cli", "@agent-wechat/wechat"];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
  throw new Error("usage: verify-published-npm-release.mjs <exact stable version>");
}

const run = (command, args, cwd = process.cwd(), options = {}) => {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
};

for (const name of packages) {
  const metadata = JSON.parse(run("npm", ["view", `${name}@${version}`, "name", "version", "--json"], process.cwd(), { capture: true }));
  if (metadata.name !== name || metadata.version !== version) {
    throw new Error(`registry returned ${metadata.name}@${metadata.version} for ${name}@${version}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "agent-wechat-production-smoke-"));
try {
  run("npm", ["init", "-y"], dir, { capture: true });
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...packages.map((name) => `${name}@${version}`)], dir);
  run("node", [join(dir, "node_modules/.bin/wx"), "--version"], dir);
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "openclaw@^2026.5.12"], dir);
  run("node", ["--input-type=module", "-e", "await Promise.all([import('@agent-wechat/cli'), import('@agent-wechat/wechat')])"], dir);
  console.log(`public registry smoke passed for ${packages.map((name) => `${name}@${version}`).join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
