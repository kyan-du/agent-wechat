#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function validateReleaseVersions(files, expected) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected ?? "")) {
    throw new Error(`invalid stable version ${expected ?? ""}`);
  }
  for (const item of files.npm) {
    if (item.version !== expected) {
      throw new Error(`${item.name} has ${item.version}, expected ${expected}`);
    }
  }
  if (files.cargo !== expected) throw new Error(`Cargo has ${files.cargo}, expected ${expected}`);
  if (files.cli !== expected) throw new Error(`CLI has ${files.cli}, expected ${expected}`);
  return true;
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const version = args[args.indexOf("--version") + 1];
const commit = args.includes("--commit") ? args[args.indexOf("--commit") + 1] : undefined;
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : undefined;

if (process.argv[1] && process.argv[1].endsWith("validate-release-consistency.mjs")) {
  if (!version) throw new Error("usage: validate-release-consistency.mjs --version X.Y.Z [--commit SHA] [--tag vX.Y.Z]");
  const readJson = path => JSON.parse(readFileSync(join(root, path), "utf8"));
  const npm = ["packages/cli", "packages/openclaw-extension", "packages/wechaty-puppet"].map(path => readJson(`${path}/package.json`));
  const cargo = readFileSync(join(root, "packages/agent-server-rust/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cliPath = join(root, "packages/cli/dist/cli.js");
  if (!existsSync(cliPath)) throw new Error("packages/cli/dist/cli.js is missing; build exact release commit first");
  const cli = readJson("packages/cli/dist/image-compatibility.json").cliVersion;
  const runtime = execFileSync("node", [cliPath, "--version"], { cwd: root, encoding: "utf8" }).trim();
  if (runtime !== version) throw new Error(`CLI --version returned ${runtime}, expected ${version}`);
  validateReleaseVersions({ npm, cargo, cli }, version);
  if (commit !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`invalid commit ${commit}`);
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (actual !== commit) throw new Error(`checked-out commit is ${actual}, expected ${commit}`);
  }
  if (tag !== undefined) {
    if (tag !== `v${version}`) throw new Error(`tag must be v${version}, got ${tag}`);
    const tagged = execFileSync("git", ["rev-list", "-n", "1", tag], { cwd: root, encoding: "utf8" }).trim();
    const expectedCommit = commit ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (tagged !== expectedCommit) throw new Error(`tag ${tag} points to ${tagged}, expected ${expectedCommit}`);
  }
  console.log(`release consistency passed for ${version}`);
}

export default validateReleaseVersions;

