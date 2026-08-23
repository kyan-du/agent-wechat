#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stage = mkdtempSync(join(tmpdir(), "agent-wechat-private-install-"));
const stateDir = join(stage, "state");
const archive = join(stage, "agent-wechat-openclaw.tgz");
const openclawProject = join(stage, "openclaw");
const openclawVersion = "2026.7.1-2";
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });

try {
  run("node", ["scripts/prepare-openclaw-plugin.mjs", archive]);
  const packListing = run("tar", ["-tf", archive]);
  for (const required of [
    "package/dist/index.js",
    "package/openclaw.plugin.json",
    "package/package.json",
  ]) {
    if (!packListing.includes(required)) throw new Error(`private archive missing ${required}`);
  }
  if (packListing.includes("node_modules/")) {
    throw new Error("private archive must not capture workspace node_modules");
  }

  mkdirSync(openclawProject);
  writeFileSync(join(openclawProject, "package.json"), '{"private":true}\n');
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", `openclaw@${openclawVersion}`],
    openclawProject,
  );
  const openclaw = join(openclawProject, "node_modules/.bin/openclaw");
  mkdirSync(stateDir);
  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(configPath, '{"plugins":{"entries":{}},"channels":{}}\n');
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };

  run(openclaw, ["plugins", "install", archive], root, env);
  const inspect = JSON.parse(
    run(openclaw, ["plugins", "inspect", "agent-wechat", "--runtime", "--json"], root, env),
  );
  if (inspect.plugin?.status !== "loaded") {
    throw new Error(`private plugin did not load: ${inspect.plugin?.error ?? "unknown"}`);
  }
  if (!inspect.plugin?.channelIds?.includes("agent-wechat")) {
    throw new Error("private plugin does not register channel agent-wechat");
  }

  const installedRoot = join(stateDir, "extensions", "agent-wechat");
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  if (!installedManifest.dependencies?.sharp) {
    throw new Error("installed plugin lost its sharp runtime dependency");
  }
  const sharpProbe = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('sharp')"],
    { cwd: installedRoot, env, encoding: "utf8" },
  );
  if (sharpProbe.status !== 0) {
    throw new Error(`installed sharp dependency is not importable: ${sharpProbe.stderr.trim()}`);
  }

  console.log(`OpenClaw ${openclawVersion} private archive install loaded channel agent-wechat`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
