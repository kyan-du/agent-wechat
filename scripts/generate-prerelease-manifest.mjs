#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const outputArg = process.argv.indexOf("--output");
if (outputArg < 0 || !process.argv[outputArg + 1]) throw new Error("usage: generate-prerelease-manifest.mjs --output <path> [--image-digest sha256:...]");
const outputPath = resolve(root, process.argv[outputArg + 1]);
const imageArg = process.argv.indexOf("--image-digest");
const imageDigest = imageArg < 0 ? process.env.PROPOSED_IMAGE_DIGEST : process.argv[imageArg + 1];
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? "")) throw new Error("a lowercase sha256 proposed image digest is required");

const run = (cmd, args, cwd = root, env = process.env) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const sha256 = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const contract = JSON.parse(readFileSync(join(root, "release/prerelease-contract.json"), "utf8"));
const commit = run("git", ["rev-parse", "HEAD"]).trim();
if (process.env.ALLOW_DIRTY_MANIFEST !== "1" && run("git", ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("tracked tree must be clean before manifest generation");

const changesets = readdirSync(join(root, ".changeset"))
  .filter((name) => name.endsWith(".md") && name !== "README.md")
  .sort()
  .map((file) => ({ file: `.changeset/${file}`, sha256: sha256(join(root, ".changeset", file)) }));
const packageDirs = new Map();
for (const entry of JSON.parse(run("pnpm", ["-r", "list", "--depth", "-1", "--json"]))) {
  const manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"));
  packageDirs.set(manifest.name, { relativeDir: entry.path.slice(root.length + 1), manifest });
}

// Version and pack an isolated copy so the evidence describes the proposed next
// bytes while the reviewed checkout remains untouched.
const stage = mkdtempSync(join(tmpdir(), "agent-wechat-prerelease-manifest-"));
let packages;
try {
  const files = run("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    const source = join(root, file);
    if (!existsSync(source)) continue;
    const destination = join(stage, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "dir");
  for (const { relativeDir } of packageDirs.values()) {
    if (!relativeDir) continue;
    const sourceModules = join(root, relativeDir, "node_modules");
    if (!existsSync(sourceModules)) continue;
    const destinationModules = join(stage, relativeDir, "node_modules");
    mkdirSync(dirname(destinationModules), { recursive: true });
    symlinkSync(sourceModules, destinationModules, "dir");
  }
  run(join(root, "node_modules/.bin/changeset"), ["pre", "enter", contract.versionPrerelease], stage);
  run(join(root, "node_modules/.bin/changeset"), ["version"], stage);

  run("pnpm", ["--filter", "@kyan-du/agent-wechat-shared", "build"], stage);
  for (const name of contract.publicPackages) run("pnpm", ["--filter", name, "build"], stage);
  packages = [];
  for (const name of [...contract.publicPackages].sort()) {
    const relativeDir = packageDirs.get(name)?.relativeDir;
    const manifest = JSON.parse(readFileSync(join(stage, relativeDir, "package.json"), "utf8"));
    if (!manifest.version.includes(`-${contract.versionPrerelease}.`)) throw new Error(`${name} did not receive a next prerelease version`);
    const pack = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], join(stage, relativeDir)))[0];
    if (!pack?.filename || !pack.integrity) throw new Error(`incomplete npm dry-run report for ${name}`);
    packages.push({
      name,
      currentVersion: packageDirs.get(name).manifest.version,
      proposedVersion: manifest.version,
      tarball: pack.filename,
      integrity: pack.integrity,
      shasum: pack.shasum,
      size: pack.size,
      unpackedSize: pack.unpackedSize,
      fileCount: pack.files?.length ?? 0,
    });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
const versions = new Set(packages.map((item) => item.proposedVersion));
if (versions.size !== 1) throw new Error(`fixed public packages have divergent proposed versions: ${[...versions].join(", ")}`);
const proposedVersion = packages[0].proposedVersion;

const manifest = {
  schema: 1,
  validationOnly: true,
  approvals: { owner: false, legalRedistribution: false },
  npmDistTag: contract.npmDistTag,
  commit,
  lockfile: { path: "pnpm-lock.yaml", sha256: sha256(join(root, "pnpm-lock.yaml")) },
  changesets,
  packages,
  proposedImage: {
    repository: contract.imageRepository,
    tag: `${contract.imageRepository}:${proposedVersion}`,
    digest: `${contract.imageRepository}@${imageDigest}`,
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(outputPath);
