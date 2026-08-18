#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { channelContract, contract, git, root, sha256Bytes, sha512Integrity } from "./agent-release-lib.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const channel = arg("--channel");
const output = arg("--output");
const artifactDir = arg("--artifacts");
if (!channel || !output || !artifactDir) throw new Error("usage: prepare-agent-release.mjs --channel <prerelease|stable> --output <manifest.json> --artifacts <directory>");
const selected = channelContract(channel);
if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("tracked checkout must be clean");
const commit = git(["rev-parse", "HEAD^{commit}"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const outputPath = resolve(root, output);
const artifactsPath = resolve(root, artifactDir);
mkdirSync(artifactsPath, { recursive: true });
if (readdirSync(artifactsPath).length) throw new Error("artifact output directory must be empty");

const stage = mkdtempSync(join(tmpdir(), "agent-wechat-release-plan-"));
try {
  const archive = join(stage, ".source.tar");
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", stage]);
  rmSync(archive);
  const run = (command, args, cwd = stage, capture = false) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["typecheck"]);
  for (const item of contract.publicPackages) run("pnpm", ["--filter", item.name, "test"]);
  run("pnpm", ["--filter", "!@kyan-du/agent-wechat-docs", "build"]);

  const packages = [];
  for (const item of contract.publicPackages) {
    const packageDir = join(stage, item.path);
    const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (packageManifest.name !== item.name) throw new Error(`package identity drift: ${item.path}`);
    if (!(new RegExp(selected.versionPattern)).test(packageManifest.version)) throw new Error(`${item.name} has invalid ${channel} version ${packageManifest.version}`);
    const report = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactsPath], packageDir, true))[0];
    const tarballPath = join(artifactsPath, report.filename);
    const bytes = readFileSync(tarballPath);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" }));
    if (manifest.name !== item.name || manifest.version !== packageManifest.version) throw new Error(`${item.name} tarball manifest drift`);
    const integrity = sha512Integrity(bytes);
    if (integrity !== report.integrity) throw new Error(`${item.name} npm integrity report drift`);
    packages.push({
      name: item.name,
      version: packageManifest.version,
      tarball: basename(tarballPath),
      sha256: sha256Bytes(bytes),
      integrity,
      size: bytes.length,
    });
  }
  const versions = new Set(packages.map((item) => item.version));
  if (versions.size !== 1) throw new Error("public packages must use one lockstep version");
  const version = packages[0].version;

  const consumer = join(stage, "release-consumer");
  mkdirSync(consumer);
  run("npm", ["init", "-y"], consumer, true);
  const stagedTarballs = packages.map((item) => {
    const destination = join(stage, "release-artifacts", item.tarball);
    mkdirSync(join(stage, "release-artifacts"), { recursive: true });
    copyFileSync(join(artifactsPath, item.tarball), destination);
    return destination;
  });
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...stagedTarballs], consumer);
  run("node", [join(consumer, "node_modules/.bin/wx"), "--version"], consumer);
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "openclaw@^2026.5.12", "wechaty-puppet@^1.10.2"], consumer);
  run("node", ["--input-type=module", "-e", "await Promise.all([import('@kyan-du/agent-wechat-openclaw'), import('@kyan-du/agent-wechat-wechaty-puppet')])"], consumer);

  const changesets = readdirSync(join(stage, ".changeset"))
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => ({ path: `.changeset/${file}`, sha256: sha256Bytes(readFileSync(join(stage, ".changeset", file))) }));
  const manifest = {
    schemaVersion: 1,
    validationOnly: true,
    repository: contract.repository,
    publisherWorkflow: contract.publisherWorkflow,
    channel,
    version,
    tag: `v${version}`,
    commit,
    tree,
    registry: contract.registry,
    distTag: selected.distTag,
    lockfile: { path: "pnpm-lock.yaml", sha256: sha256Bytes(readFileSync(join(stage, "pnpm-lock.yaml"))) },
    changesets,
    packages,
  };
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ manifest: outputPath, artifacts: artifactsPath, version, commit }, null, 2));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
