#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { contract, exactKeys, requireDigest, requireOid, root, sha256Bytes, sha512Integrity, strictJson, validateReleaseIdentity } from "./agent-release-lib.mjs";

export function verifyReleaseManifest(manifest, { artifactDir, expectedChannel, expectedVersion, expectedCommit, expectedManifestSha256 } = {}) {
  exactKeys(manifest, ["schemaVersion", "validationOnly", "repository", "publisherWorkflow", "version", "tag", "commit", "tree", "registry", "distTag", "lockfile", "changesets", "packages"], "release manifest");
  if (manifest.schemaVersion !== 1 || manifest.validationOnly !== true) throw new Error("release manifest must be schema 1 validation evidence");
  if (manifest.repository !== contract.repository || manifest.registry !== contract.registry || manifest.publisherWorkflow !== contract.publisherWorkflow) throw new Error("release repository/registry/publisher drift");
  validateReleaseIdentity(manifest);
  if (expectedVersion && manifest.version !== expectedVersion) throw new Error("release version drift");
  requireOid(manifest.commit, "release commit");
  requireOid(manifest.tree, "release tree");
  if (expectedCommit && manifest.commit !== expectedCommit) throw new Error("release commit drift");
  exactKeys(manifest.lockfile, ["path", "sha256"], "lockfile identity");
  if (manifest.lockfile.path !== "pnpm-lock.yaml") throw new Error("lockfile path drift");
  requireDigest(manifest.lockfile.sha256, "lockfile digest");
  if (!Array.isArray(manifest.changesets)) throw new Error("changesets must be an array");
  let priorChangeset = "";
  for (const item of manifest.changesets) {
    exactKeys(item, ["path", "sha256"], "changeset identity");
    if (!/^\.changeset\/[A-Za-z0-9._-]+\.md$/.test(item.path) || item.path <= priorChangeset) throw new Error("changesets must be sorted canonical paths");
    priorChangeset = item.path;
    requireDigest(item.sha256, "changeset digest");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== contract.publicPackages.length) throw new Error("release package count drift");
  for (let index = 0; index < contract.publicPackages.length; index += 1) {
    const expected = contract.publicPackages[index];
    const item = manifest.packages[index];
    exactKeys(item, ["name", "version", "tarball", "sha256", "integrity", "size"], `package ${index}`);
    if (item.name !== expected.name || item.version !== manifest.version) throw new Error("release package identity/version drift");
    const expectedFilename = `${item.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    if (item.tarball !== expectedFilename) throw new Error(`${item.name} tarball filename drift`);
    requireDigest(item.sha256, `${item.name} sha256`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) throw new Error(`${item.name} has invalid SRI`);
    if (!Number.isSafeInteger(item.size) || item.size <= 0) throw new Error(`${item.name} has invalid size`);
    if (artifactDir) {
      const bytes = readFileSync(join(artifactDir, item.tarball));
      if (bytes.length !== item.size || sha256Bytes(bytes) !== item.sha256 || sha512Integrity(bytes) !== item.integrity) {
        throw new Error(`${item.name} artifact integrity mismatch`);
      }
      const packed = JSON.parse(execFileSync("tar", ["-xOf", join(artifactDir, item.tarball), "package/package.json"], { encoding: "utf8" }));
      if (packed.name !== item.name || packed.version !== item.version) throw new Error(`${item.name} packed manifest mismatch`);
    }
  }
  if (expectedManifestSha256) requireDigest(expectedManifestSha256, "expected manifest digest");
  return manifest;
}

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
if (process.argv[1]?.endsWith("verify-agent-release.mjs")) {
  const manifestPath = resolve(root, arg("--manifest") ?? "");
  const artifactDir = resolve(root, arg("--artifacts") ?? "");
  if (!arg("--manifest") || !arg("--artifacts")) throw new Error("usage: verify-agent-release.mjs --manifest <manifest.json> --artifacts <directory> [--channel ... --version ... --commit ... --manifest-sha256 ...]");
  const raw = readFileSync(manifestPath);
  const expectedManifestSha256 = arg("--manifest-sha256");
  if (expectedManifestSha256 && sha256Bytes(raw) !== expectedManifestSha256) throw new Error("release manifest digest mismatch");
  const manifest = verifyReleaseManifest(strictJson(raw.toString("utf8"), "release manifest"), {
    artifactDir,
    expectedVersion: arg("--version"),
    expectedCommit: arg("--commit"),
    expectedManifestSha256,
  });
  const consumer = mkdtempSync(join(tmpdir(), "agent-wechat-artifact-verify-"));
  try {
    execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...manifest.packages.map((item) => join(artifactDir, item.tarball))], { cwd: consumer, stdio: "inherit" });
    execFileSync("node", [join(consumer, "node_modules/.bin/wx"), "--version"], { cwd: consumer, stdio: "inherit" });
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
  console.log(`verified formal release artifact set ${manifest.version}`);
}
