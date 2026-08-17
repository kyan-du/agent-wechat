#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-auth-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["remote", "add", "origin", dir]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "release", version: "1.2.3-next.4" }));
  writeFileSync(join(dir, "release-file"), "immutable\n");
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "add", "."]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release"]);
  const release = git(dir, ["rev-parse", "HEAD"]);
  const tree = git(dir, ["rev-parse", `${release}^{tree}`]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-a", "v1.2.3-next.4", release, "-m", "release"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", release]);
  git(dir, ["checkout", "-b", "authorization"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "receipt base"]);
  mkdirSync(join(dir, "release"), { recursive: true });
  const receipt = {
    schemaVersion: 1,
    enabled: true,
    tag: "v1.2.3-next.4",
    releaseCommit: release,
    releaseTree: tree,
    approvals: {
      owner: true, legalRedistribution: true, protectedEnvironment: true,
      trustedPublishers: true, protectedTagRules: true, registryStateReconciled: true,
    },
  };
  writeFileSync(join(dir, "release/npm-release-authorization.json"), JSON.stringify(receipt));
  const receiptCommit = commit(dir, "authorization receipt");
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-a", "npm-release-auth/v1.2.3-next.4", receiptCommit, "-m", "authorization"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", receiptCommit]);
  return { dir, release, tree, receiptCommit, receipt };
};
const verify = ({ dir, release, receiptCommit }, overrides = {}) => spawnSync(
  process.execPath,
  [verifier, overrides.tag ?? "v1.2.3-next.4", overrides.release ?? release,
   overrides.ref ?? "refs/tags/npm-release-auth/v1.2.3-next.4", overrides.receipt ?? receiptCommit],
  { cwd: dir, encoding: "utf8" },
);
const expectFail = (scenario, mutate) => {
  const state = setup();
  mutate(state);
  assert.notEqual(verify(state).status, 0, scenario);
};

const good = setup();
assert.equal(verify(good).status, 0, "real independent receipt should pass");
expectFail("edited receipt", (state) => {
  const path = join(state.dir, "release/npm-release-authorization.json");
  writeFileSync(path, readFileSync(path, "utf8").replace('"owner":true', '"owner":false'));
  state.receiptCommit = commit(state.dir, "edited receipt");
  git(state.dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-f", "-a", "npm-release-auth/v1.2.3-next.4", state.receiptCommit, "-m", "edited"]);
});
expectFail("stale receipt ref", ({ dir, receiptCommit }) => git(dir, ["tag", "-f", "npm-release-auth/v1.2.3-next.4", `${receiptCommit}^`]));
expectFail("moved release tag", ({ dir, receiptCommit }) => git(dir, ["tag", "-f", "v1.2.3-next.4", receiptCommit]));
expectFail("deleted release tag", ({ dir }) => git(dir, ["tag", "-d", "v1.2.3-next.4"]));
expectFail("changed release tree", (state) => { state.release = state.receiptCommit; });
expectFail("non-main receipt", ({ dir, release }) => git(dir, ["update-ref", "refs/remotes/origin/main", release]));
expectFail("lightweight receipt", ({ dir, receiptCommit }) => {
  git(dir, ["tag", "-d", "npm-release-auth/v1.2.3-next.4"]);
  git(dir, ["tag", "npm-release-auth/v1.2.3-next.4", receiptCommit]);
});
expectFail("ambiguous branch/ref", ({ dir }) => git(dir, ["branch", "npm-release-auth/v1.2.3-next.4"]));
expectFail("receipt replay", (state) => { state.release = `${state.release}^`; });
console.log("npm authorization Git E2E matrix passed");
