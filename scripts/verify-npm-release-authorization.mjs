#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [tag, commit] = process.argv.slice(2);
if (!tag || !commit) throw new Error("usage: verify-npm-release-authorization.mjs <tag> <commit>");
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
if (authorization.tag !== tag || authorization.commit !== commit) {
  throw new Error("npm release authorization does not match the exact tag and commit");
}
for (const gate of required) {
  if (authorization.approvals?.[gate] !== true) throw new Error(`npm release gate is not approved: ${gate}`);
}
console.log(`npm release authorized for ${tag} at ${commit}`);
