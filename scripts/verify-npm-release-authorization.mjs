#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";

const [tag, releaseCommit, receiptRef, expectedReceiptCommit, expectedReceiptTagOid, expectedReleaseTagOid] = process.argv.slice(2);
if (!tag || !releaseCommit || !receiptRef || !expectedReceiptCommit || !expectedReceiptTagOid || !expectedReleaseTagOid) {
  throw new Error("usage: verify-npm-release-authorization.mjs <tag> <release-commit> <receipt-ref> <receipt-commit> <receipt-tag-oid> <release-tag-oid>");
}
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const oid = /^[0-9a-f]{40}$/;
for (const value of [releaseCommit, expectedReceiptCommit, expectedReceiptTagOid, expectedReleaseTagOid]) {
  if (!oid.test(value)) throw new Error("release, receipt commit, and receipt tag must be exact OIDs");
}
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
if (run(["rev-parse", receiptRef]) !== expectedReceiptTagOid) {
  throw new Error("authorization receipt tag object does not match the protected exact OID");
}
const tagTarget = (tagOid) => run(["cat-file", "-p", tagOid]).match(/^object ([0-9a-f]{40})$/m)?.[1];
const receiptTarget = tagTarget(expectedReceiptTagOid);
if (run(["cat-file", "-t", expectedReceiptTagOid]) !== "tag" ||
    !receiptTarget || run(["cat-file", "-t", receiptTarget]) !== "commit" ||
    receiptTarget !== expectedReceiptCommit) {
  throw new Error("authorization receipt must be exactly one annotated tag to the configured commit");
}
const releaseTagRef = `refs/tags/${tag}`;
const releaseTagOid = run(["rev-parse", releaseTagRef]);
if (releaseTagOid !== expectedReleaseTagOid) throw new Error("release tag object does not match the protected exact OID");
const releaseTarget = tagTarget(releaseTagOid);
if (run(["cat-file", "-t", releaseTagOid]) !== "tag" ||
    !releaseTarget || run(["cat-file", "-t", releaseTarget]) !== "commit" ||
    releaseTarget !== releaseCommit) {
  throw new Error("release tag must be exactly one annotated tag to the authorized release commit");
}
execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, expectedReceiptCommit], { stdio: "ignore" });
execFileSync("git", ["merge-base", "--is-ancestor", expectedReceiptCommit, "origin/main"], { stdio: "ignore" });
const path = "release/npm-release-authorization.json";
const entry = run(["ls-tree", expectedReceiptCommit, "--", path]).split(/\s+/);
if (entry.length !== 4 || entry[0] !== "100644" || entry[1] !== "blob" || entry[3] !== path) {
  throw new Error("authorization receipt must be one regular mode-100644 blob");
}
const raw = run(["show", `${expectedReceiptCommit}:${path}`]);
let authorization;
try {
  authorization = JSON.parse(raw);
} catch {
  throw new Error("authorization receipt must be strict JSON");
}
const duplicateDocument = parseDocument(raw, { uniqueKeys: true, prettyErrors: false });
if (duplicateDocument.errors.length) {
  throw new Error(`authorization receipt JSON is ambiguous: ${duplicateDocument.errors[0].message}`);
}
const exactKeys = (object, keys, label) => {
  if (!object || typeof object !== "object" || Array.isArray(object) ||
      JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys do not match the exact authorization schema`);
  }
};
exactKeys(authorization, ["schemaVersion", "enabled", "tag", "releaseCommit", "releaseTree", "intent", "approvals"], "authorization");
exactKeys(authorization.intent, ["registry", "distTag", "packages"], "intent");
const gates = ["owner", "legalRedistribution", "protectedEnvironment", "trustedPublishers", "protectedTagRules", "registryStateReconciled"];
exactKeys(authorization.approvals, gates, "approvals");
const expectedNames = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"];
if (!Array.isArray(authorization.intent.packages) || authorization.intent.packages.length !== 3) throw new Error("authorization package intent must contain exactly three packages");
const version = tag.slice(1);
for (let index = 0; index < expectedNames.length; index += 1) {
  const item = authorization.intent.packages[index];
  exactKeys(item, ["name", "version"], `package intent ${index}`);
  if (item.name !== expectedNames[index] || item.version !== version) throw new Error("authorization package/version intent drift");
}
if (authorization.intent.registry !== "https://registry.npmjs.org" || authorization.intent.distTag !== "next") throw new Error("authorization registry/dist-tag intent drift");
if (authorization.schemaVersion !== 1 || authorization.enabled !== true) throw new Error("npm prerelease publication is disabled pending independent release authorization");
if (authorization.tag !== tag || authorization.releaseCommit !== releaseCommit) throw new Error("npm release receipt does not match the exact tag and release commit");
if (authorization.releaseTree !== run(["rev-parse", `${releaseCommit}^{tree}`])) throw new Error("npm release receipt does not match the immutable release tree");
for (const gate of gates) if (authorization.approvals[gate] !== true) throw new Error(`npm release gate is not approved: ${gate}`);
console.log(`npm release authorized for ${tag} at ${releaseCommit} by receipt tag ${expectedReceiptTagOid}`);
