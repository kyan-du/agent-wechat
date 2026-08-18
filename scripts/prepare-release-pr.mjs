#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { channelContract, contract, git, root } from "./agent-release-lib.mjs";
import { prereleaseEnterRequired } from "./prerelease-state.mjs";

const channel = process.argv[process.argv.indexOf("--channel") + 1];
if (!channel || !["prerelease", "stable"].includes(channel)) throw new Error("usage: prepare-release-pr.mjs --channel <prerelease|stable>");
channelContract(channel);
if (git(["status", "--porcelain"])) throw new Error("Release PR preparation requires a completely clean worktree");
const branch = git(["symbolic-ref", "--short", "HEAD"]);
if (branch === "main" || branch === "master") throw new Error("Release PR preparation must run on an isolated release branch");
execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
const changeset = join(root, "node_modules/.bin/changeset");
const prePath = join(root, ".changeset/pre.json");
if (channel === "prerelease") {
  if (prereleaseEnterRequired(prePath, "next")) execFileSync(changeset, ["pre", "enter", "next"], { cwd: root, stdio: "inherit" });
} else {
  if (!existsSync(prePath)) throw new Error("stable promotion requires an existing reviewed next prerelease state");
  const pre = JSON.parse(readFileSync(prePath, "utf8"));
  if (pre.mode === "pre" && pre.tag === "next") execFileSync(changeset, ["pre", "exit"], { cwd: root, stdio: "inherit" });
  else if (pre.mode !== "exit" || pre.tag !== "next") throw new Error("stable promotion prerelease state drift");
}
execFileSync(changeset, ["version"], { cwd: root, stdio: "inherit" });
execFileSync("bash", ["scripts/sync-cargo-version.sh"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });
const versions = contract.publicPackages.map((item) => JSON.parse(readFileSync(join(root, item.path, "package.json"), "utf8")).version);
if (new Set(versions).size !== 1 || !(new RegExp(channelContract(channel).versionPattern)).test(versions[0])) throw new Error("Changesets did not produce one valid lockstep public version");
console.log(`prepared ${channel} Release PR files for ${versions[0]}; review and commit all generated version/changelog/lockfile changes`);
