#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { exactStableVersionPattern } from "./npm-release-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const cliManifest = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
const version = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : cliManifest.version;
const tarballIndex = process.argv.indexOf("--tarballs");
const tarballDir = tarballIndex >= 0 ? resolve(root, process.argv[tarballIndex + 1] ?? "") : undefined;
const packages = [
  { dir: "packages/cli", name: "@kyan-du/agent-wechat-cli", tarball: `kyan-du-agent-wechat-cli-${version}.tgz` },
  { dir: "packages/openclaw-extension", name: "@kyan-du/agent-wechat-openclaw", tarball: `kyan-du-agent-wechat-openclaw-${version}.tgz` },
  { dir: "packages/wechaty-puppet", name: "@kyan-du/agent-wechat-wechaty-puppet", tarball: `kyan-du-agent-wechat-wechaty-puppet-${version}.tgz` },
];

if (!exactStableVersionPattern.test(version ?? "")) {
  throw new Error("version must be an exact stable semver, for example 0.12.0");
}

for (const item of packages) {
  const manifestPath = join(root, item.dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== item.name) throw new Error(`${item.dir}: expected package name ${item.name}, found ${manifest.name}`);
  if (manifest.version !== version) throw new Error(`${item.name}: expected version ${version}, found ${manifest.version}`);
  if (manifest.private === true) throw new Error(`${item.name}: must be publishable`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    throw new Error(`${item.name}: publishConfig.access=public and publishConfig.provenance=true are required`);
  }
}

const cargo = readFileSync(join(root, "packages/agent-server-rust/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargo !== version) throw new Error(`Cargo version ${cargo} != ${version}`);

if (tarballDir) {
  const files = readdirSync(tarballDir).filter((name) => name.endsWith(".tgz")).sort();
  const expected = packages.map((item) => item.tarball).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tarballs: expected ${expected.join(", ")}, found ${files.join(", ")}`);
  }
  for (const item of packages) {
    const tarball = join(tarballDir, item.tarball);
    if (!existsSync(tarball)) throw new Error(`missing tarball ${item.tarball}`);
    const packed = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { cwd: root, encoding: "utf8" }));
    if (packed.name !== item.name || packed.version !== version) {
      throw new Error(`${basename(tarball)} contains ${packed.name}@${packed.version}`);
    }
    if (!packed.files?.includes("dist")) throw new Error(`${item.name}: packed manifest must retain dist allowlist`);
  }
}

console.log(`npm production release candidate valid for ${packages.map((item) => `${item.name}@${version}`).join(", ")}`);
