#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const verifier = join(process.cwd(), "scripts/verify-npm-release-authorization.mjs");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd, message) => {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};
const tag = (cwd, name, target, message) => {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-f", "-a", name, target, "-m", message]);
  return git(cwd, ["rev-parse", `refs/tags/${name}`]);
};
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-auth-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["remote", "add", "origin", dir]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "release", version: "1.2.3-next.4" }));
  writeFileSync(join(dir, "release-file"), "immutable\n");
  const release = commit(dir, "release");
  const tree = git(dir, ["rev-parse", `${release}^{tree}`]);
  const releaseTagOid = tag(dir, "v1.2.3-next.4", release, "release");
  git(dir, ["update-ref", "refs/remotes/origin/main", release]);
  git(dir, ["checkout", "-b", "authorization"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "receipt base"]);
  mkdirSync(join(dir, "release"), { recursive: true });
  const version = "1.2.3-next.4";
  const receipt = {
    schemaVersion: 1, enabled: true, tag: `v${version}`,
    releaseCommit: release, releaseTree: tree,
    intent: {
      registry: "https://registry.npmjs.org", distTag: "next",
      packages: [
        { name: "@kyan-du/agent-wechat-cli", version },
        { name: "@kyan-du/agent-wechat-openclaw", version },
        { name: "@kyan-du/agent-wechat-wechaty-puppet", version },
      ],
    },
    approvals: {
      owner: true, legalRedistribution: true, protectedEnvironment: true,
      trustedPublishers: true, protectedTagRules: true, registryStateReconciled: true,
    },
  };
  writeFileSync(join(dir, "release/npm-release-authorization.json"), JSON.stringify(receipt));
  const receiptCommit = commit(dir, "authorization receipt");
  const receiptTagOid = tag(dir, "npm-release-auth/v1.2.3-next.4", receiptCommit, "authorization");
  git(dir, ["update-ref", "refs/remotes/origin/main", receiptCommit]);
  return { dir, release, tree, releaseTagOid, receiptCommit, receiptTagOid, receipt };
};
const verify = (state, overrides = {}) => spawnSync(process.execPath, [
  verifier, overrides.tag ?? "v1.2.3-next.4", overrides.release ?? state.release,
  overrides.ref ?? "refs/tags/npm-release-auth/v1.2.3-next.4",
  overrides.receipt ?? state.receiptCommit, overrides.tagOid ?? state.receiptTagOid,
  overrides.releaseTagOid ?? state.releaseTagOid,
], { cwd: state.dir, encoding: "utf8" });
const expectFail = (scenario, mutate) => {
  const state = setup(); mutate(state);
  assert.notEqual(verify(state).status, 0, scenario);
};

assert.equal(verify(setup()).status, 0, "real independent receipt should pass");
expectFail("edited receipt", (s) => {
  const p = join(s.dir, "release/npm-release-authorization.json");
  writeFileSync(p, readFileSync(p, "utf8").replace('"owner":true', '"owner":false'));
  s.receiptCommit = commit(s.dir, "edited"); s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "edited");
});
expectFail("moved receipt tag object same commit", (s) => { tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "different message"); });
expectFail("moved release tag object same commit", (s) => { tag(s.dir, "v1.2.3-next.4", s.release, "different release message"); });
expectFail("receipt tag of tag", (s) => { s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptTagOid, "nested"); });
expectFail("release tag of tag", (s) => { s.releaseTagOid = tag(s.dir, "v1.2.3-next.4", s.releaseTagOid, "nested release"); });
expectFail("deleted release tag", (s) => git(s.dir, ["tag", "-d", "v1.2.3-next.4"]));
expectFail("non-main receipt", (s) => git(s.dir, ["update-ref", "refs/remotes/origin/main", s.release]));
expectFail("lightweight receipt", (s) => { git(s.dir, ["tag", "-d", "npm-release-auth/v1.2.3-next.4"]); git(s.dir, ["tag", "npm-release-auth/v1.2.3-next.4", s.receiptCommit]); s.receiptTagOid = git(s.dir, ["rev-parse", "refs/tags/npm-release-auth/v1.2.3-next.4"]); });
expectFail("ambiguous branch/ref", (s) => git(s.dir, ["branch", "npm-release-auth/v1.2.3-next.4"]));
expectFail("receipt replay", (s) => { s.release = `${s.release}^`; });
expectFail("symlink receipt", (s) => { const p = join(s.dir, "release/npm-release-authorization.json"); rmSync(p); symlinkSync("../package.json", p); s.receiptCommit = commit(s.dir, "symlink"); s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "symlink"); });
expectFail("duplicate JSON keys", (s) => { const p = join(s.dir, "release/npm-release-authorization.json"); writeFileSync(p, readFileSync(p, "utf8").replace('"owner":true', '"owner":false,"owner":true')); s.receiptCommit = commit(s.dir, "duplicate"); s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "duplicate"); });
expectFail("unknown receipt key", (s) => { const p = join(s.dir, "release/npm-release-authorization.json"); writeFileSync(p, readFileSync(p, "utf8").replace('{"schemaVersion"', '{"unknown":true,"schemaVersion"')); s.receiptCommit = commit(s.dir, "unknown"); s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "unknown"); });
expectFail("semantic package drift", (s) => { const p = join(s.dir, "release/npm-release-authorization.json"); writeFileSync(p, readFileSync(p, "utf8").replace('"distTag":"next"', '"distTag":"latest"')); s.receiptCommit = commit(s.dir, "drift"); s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "drift"); });
expectFail("non-JSON YAML receipt", (s) => {
  const p = join(s.dir, "release/npm-release-authorization.json");
  writeFileSync(p, "schemaVersion: 1\nenabled: true\ntag: v1.2.3-next.4\nreleaseCommit: " + s.release + "\nreleaseTree: " + s.tree + "\n");
  s.receiptCommit = commit(s.dir, "yaml");
  s.receiptTagOid = tag(s.dir, "npm-release-auth/v1.2.3-next.4", s.receiptCommit, "yaml");
});
console.log("npm authorization Git E2E matrix passed");
