#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const [tag, releaseCommit, receiptRef, expectedReceiptCommit] = process.argv.slice(2);
if (!tag || !releaseCommit || !receiptRef || !expectedReceiptCommit) {
  throw new Error("usage: verify-npm-release-authorization.mjs <tag> <release-commit> <receipt-ref> <receipt-commit>");
}
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const oid = /^[0-9a-f]{40}$/;
if (!oid.test(releaseCommit) || !oid.test(expectedReceiptCommit)) throw new Error("release and receipt commits must be exact OIDs");
if (!/^refs\/tags\/npm-release-auth\/v[0-9]+\.[0-9]+\.[0-9]+-next\.[0-9]+$/.test(receiptRef)) {
  throw new Error("authorization must use the exact protected receipt tag namespace");
}
const receiptShort = receiptRef.slice("refs/tags/".length);
try {
  run(["show-ref", "--verify", `refs/heads/${receiptShort}`]);
  throw new Error("authorization receipt name is ambiguous with a branch");
} catch (error) {
  if (String(error).includes("ambiguous with a branch")) throw error;
}
if (run(["rev-parse", `${receiptRef}^{commit}`]) !== expectedReceiptCommit) {
  throw new Error("authorization receipt ref does not match the independently configured commit");
}
if (run(["cat-file", "-t", receiptRef]) !== "tag") {
  throw new Error("authorization receipt must be an annotated tag, not a branch/lightweight/tag-of-tag alias");
}
const releaseTagRef = `refs/tags/${tag}`;
if (run(["rev-parse", `${releaseTagRef}^{commit}`]) !== releaseCommit) {
  throw new Error("release tag no longer matches the authorized release commit");
}
if (run(["cat-file", "-t", releaseTagRef]) !== "tag") {
  throw new Error("release tag must be annotated");
}
execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, expectedReceiptCommit], { stdio: "ignore" });
execFileSync("git", ["merge-base", "--is-ancestor", expectedReceiptCommit, "origin/main"], { stdio: "ignore" });
const raw = run(["show", `${expectedReceiptCommit}:release/npm-release-authorization.json`]);
const authorization = JSON.parse(raw);
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
  throw new Error("npm release receipt does not match the exact tag and release commit");
}
if (authorization.releaseTree !== run(["rev-parse", `${releaseCommit}^{tree}`])) {
  throw new Error("npm release receipt does not match the immutable release tree");
}
for (const gate of required) {
  if (authorization.approvals?.[gate] !== true) throw new Error(`npm release gate is not approved: ${gate}`);
}
console.log(`npm release authorized for ${tag} at ${releaseCommit} by receipt ${expectedReceiptCommit}`);
