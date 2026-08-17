#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [tag, releaseCommit] = process.argv.slice(2);
if (!tag || !releaseCommit) throw new Error("usage: verify-npm-release-authorization.mjs <tag> <release-commit>");
const authorization = JSON.parse(readFileSync("release/npm-release-authorization.json", "utf8"));
const required = [
  "owner",
  "legalRedistribution",
  "protectedEnvironment",
  "trustedPublishers",
  "protectedTagRules",
  "registryStateReconciled",
];
if (authorization.schemaVersion !== 1 || authorization.enabled !== true) {
  throw new Error("npm prerelease publication is disabled pending independent release authorization");
}
if (authorization.tag !== tag || authorization.releaseCommit !== releaseCommit) {
  throw new Error("npm release authorization does not match the exact tag and release commit");
}
const releaseTree = execFileSync("git", ["rev-parse", `${releaseCommit}^{tree}`], { encoding: "utf8" }).trim();
if (authorization.releaseTree !== releaseTree) {
  throw new Error("npm release authorization does not match the immutable release tree");
}
const receiptCommit = execFileSync("git", ["log", "-1", "--format=%H", "--", "release/npm-release-authorization.json"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(authorization.receiptCommit) || authorization.receiptCommit !== receiptCommit) {
  throw new Error("npm release authorization receipt is not bound to its independent commit");
}
if (authorization.receiptCommit === releaseCommit) {
  throw new Error("npm release authorization must be committed after the release commit");
}
execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, authorization.receiptCommit], { stdio: "ignore" });
for (const gate of required) {
  if (authorization.approvals?.[gate] !== true) throw new Error(`npm release gate is not approved: ${gate}`);
}
console.log(`npm release authorized for ${tag} at ${releaseCommit} by receipt ${receiptCommit}`);
