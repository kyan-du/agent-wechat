#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contract, git, root } from "./agent-release-lib.mjs";

if (process.argv.includes("--channel")) throw new Error("release channels are unsupported; only a formal stable release exists");
if (git(["status", "--porcelain"])) throw new Error("Release PR preparation requires a completely clean worktree");
const branch = git(["symbolic-ref", "--short", "HEAD"]);
if (branch === "main" || branch === "master") throw new Error("Release PR preparation must run on an isolated release branch");
execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
const changeset = join(root, "node_modules/.bin/changeset");
const prePath = join(root, ".changeset/pre.json");
if (existsSync(prePath)) {
  const pre = JSON.parse(readFileSync(prePath, "utf8"));
  if (pre.mode === "pre") execFileSync(changeset, ["pre", "exit"], { cwd: root, stdio: "inherit" });
  else if (pre.mode !== "exit") throw new Error("Changesets prerelease state is invalid");
}
execFileSync(changeset, ["version"], { cwd: root, stdio: "inherit" });
execFileSync("bash", ["scripts/sync-cargo-version.sh"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });
const versions = contract.publicPackages.map((item) => JSON.parse(readFileSync(join(root, item.path, "package.json"), "utf8")).version);
if (new Set(versions).size !== 1 || !(new RegExp(contract.versionPattern)).test(versions[0])) throw new Error("Changesets did not produce one valid lockstep stable version");
console.log(`prepared formal Release PR files for ${versions[0]}; review and commit generated version/changelog/lockfile changes`);
