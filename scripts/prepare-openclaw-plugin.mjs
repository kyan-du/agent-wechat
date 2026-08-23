#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const source = resolve("packages/openclaw-extension");
const target = resolve(process.argv[2] ?? ".artifacts/agent-wechat-openclaw.tgz");
if (!existsSync(resolve(source, "dist/index.js"))) {
  throw new Error(
    "packages/openclaw-extension/dist/index.js is missing; run pnpm --filter @kyan-du/agent-wechat-openclaw build first",
  );
}

const manifest = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
if (!manifest.dependencies?.sharp) {
  throw new Error("OpenClaw package must declare sharp as a runtime dependency");
}

mkdirSync(dirname(target), { recursive: true });
const stage = mkdtempSync(join(tmpdir(), "agent-wechat-openclaw-pack-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(
    npm,
    ["pack", source, "--json", "--pack-destination", stage],
    { encoding: "utf8" },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed: ${packed.stderr.trim() || packed.stdout.trim()}`);
  }
  const report = JSON.parse(packed.stdout);
  const filename = report?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error("npm pack did not report a tarball");
  }
  const temporaryTarget = `${target}.tmp-${process.pid}`;
  rmSync(temporaryTarget, { force: true });
  copyFileSync(join(stage, filename), temporaryTarget);
  rmSync(target, { recursive: true, force: true });
  renameSync(temporaryTarget, target);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(target);
