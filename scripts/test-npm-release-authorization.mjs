#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "./agent-release-lib.mjs";

const verifier = join(process.cwd(), "scripts/verify-npm-release-authorization.mjs");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd, message) => { git(cwd, ["add", "."]); git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]); return git(cwd, ["rev-parse", "HEAD"]); };
const tag = (cwd, name, target, message) => { git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-f", "-a", name, target, "-m", message]); return git(cwd, ["rev-parse", `refs/tags/${name}`]); };
const authorizationId = "a".repeat(32);
const nonce = "one-time-nonce-not-stored";
const version = "1.2.3-next.4";
const tagName = `v${version}`;
const packageNames = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "npm-auth-v2-"));
  git(dir, ["init", "-b", "main"]); git(dir, ["remote", "add", "origin", dir]);
  writeFileSync(join(dir, "release-file"), "immutable\n");
  const releaseCommit = commit(dir, "release");
  const releaseTree = git(dir, ["rev-parse", `${releaseCommit}^{tree}`]);
  const packages = packageNames.map((name) => ({ name, version, tarball: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`, sha256: `sha256:${"3".repeat(64)}`, integrity: "sha512-AAAA", size: 1 }));
  const manifest = { schemaVersion: 1, validationOnly: true, repository: "kyan-du/agent-wechat", channel: "prerelease", version, tag: tagName, commit: releaseCommit, tree: releaseTree, registry: "https://registry.npmjs.org", distTag: "next", lockfile: { path: "pnpm-lock.yaml", sha256: `sha256:${"4".repeat(64)}` }, changesets: [], packages };
  const manifestPath = join(dir, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  git(dir, ["update-ref", "refs/remotes/origin/main", releaseCommit]);
  git(dir, ["checkout", "-b", "authorization"]); mkdirSync(join(dir, "release"));
  const receipt = { schemaVersion: 2, enabled: true, repository: manifest.repository, channel: manifest.channel, authorizationId, nonceSha256: sha256Bytes(Buffer.from(nonce)), ownerConfirmationRefSha256: `sha256:${"5".repeat(64)}`, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:15:00.000Z", release: { tag: tagName, commit: releaseCommit, tree: releaseTree, manifestSha256: sha256Bytes(readFileSync(manifestPath)) }, intent: { registry: manifest.registry, distTag: manifest.distTag, packages: packages.map(({ name, version: v, tarball, sha256, integrity }) => ({ name, version: v, tarball, sha256, integrity })) }, approvals: { owner: true, legalRedistribution: true, protectedEnvironment: true, trustedPublishers: true, protectedTagRules: true, registryStateReconciled: true }, consumption: { state: "unused", tag: `npm-release-consumed/${tagName}/${authorizationId}` } };
  writeFileSync(join(dir, "release/npm-release-authorization.json"), JSON.stringify(receipt));
  const receiptCommit = commit(dir, "authorization receipt");
  const receiptName = `npm-release-auth/${tagName}/${authorizationId}`;
  const receiptTagOid = tag(dir, receiptName, receiptCommit, "authorization");
  git(dir, ["update-ref", "refs/remotes/origin/main", receiptCommit]);
  return { dir, manifestPath, manifest, receipt, receiptCommit, receiptTagOid, receiptName, releaseCommit };
}
function verify(state, overrides = {}) {
  return spawnSync(process.execPath, [verifier, state.manifestPath, overrides.releaseCommit ?? state.releaseCommit, `refs/tags/${state.receiptName}`, overrides.receiptCommit ?? state.receiptCommit, overrides.receiptTagOid ?? state.receiptTagOid, authorizationId], { cwd: state.dir, encoding: "utf8", env: { ...process.env, RELEASE_AUTHORIZATION_NONCE: overrides.nonce ?? state.nonce ?? nonce, RELEASE_AUTHORIZATION_NOW: "2026-08-18T00:05:00.000Z" } });
}
function reject(label, mutate) { const state = setup(); mutate(state); assert.notEqual(verify(state).status, 0, label); rmSync(state.dir, { recursive: true, force: true }); }
const valid = setup(); assert.equal(verify(valid).status, 0, verify(valid).stderr); rmSync(valid.dir, { recursive: true, force: true });
reject("nonce replay", (state) => { state.nonce = "wrong"; });
reject("moved receipt tag object", (state) => { tag(state.dir, state.receiptName, state.receiptCommit, "different annotation"); });
reject("receipt tag of tag", (state) => { state.receiptTagOid = tag(state.dir, state.receiptName, state.receiptTagOid, "nested"); });
reject("non-main receipt", (state) => { git(state.dir, ["update-ref", "refs/remotes/origin/main", state.releaseCommit]); });
reject("ambiguous branch", (state) => { git(state.dir, ["branch", state.receiptName]); });
reject("release commit replay", (state) => { state.releaseCommit = `${state.releaseCommit}^`; });
reject("consumed authorization", (state) => { tag(state.dir, state.receipt.consumption.tag, state.receiptCommit, "consumed"); });
reject("manifest drift", (state) => { state.manifest.version = "1.2.3-next.5"; writeFileSync(state.manifestPath, JSON.stringify(state.manifest)); });
reject("non-JSON receipt", (state) => { writeFileSync(join(state.dir, "release/npm-release-authorization.json"), "enabled: true\n"); state.receiptCommit = commit(state.dir, "yaml"); state.receiptTagOid = tag(state.dir, state.receiptName, state.receiptCommit, "yaml"); git(state.dir, ["update-ref", "refs/remotes/origin/main", state.receiptCommit]); });
console.log("npm authorization v2 Git E2E matrix passed");
