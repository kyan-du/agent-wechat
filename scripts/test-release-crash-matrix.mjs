#!/usr/bin/env node
import assert from "node:assert/strict";
import { reconcilePublication, verifyOperationReceipt } from "./release-reconciliation.mjs";

const version = "1.2.3-next.4";
const packages = ["cli", "openclaw", "puppet"].map((name, index) => ({ name: `@scope/${name}`, version, integrity: `sha512-${index}` }));
const manifest = { publisherWorkflow: ".github/workflows/npm-agent-release.yml", channel: "prerelease", version, commit: "1".repeat(40), tree: "2".repeat(40), distTag: "next", packages };
const exists = (item) => ({ name: item.name, kind: "exists", version, integrity: item.integrity, provenance: { state: "verified", repository: "kyan-du/agent-wechat", workflow: manifest.publisherWorkflow, commit: manifest.commit } });
const absent = (item) => ({ name: item.name, kind: "absent" });
const tags = (count) => Object.fromEntries(packages.map((item, index) => [item.name, index < count ? version : "old"]));

// Crash before each package write and after each completed package write.
for (let published = 0; published <= packages.length; published += 1) {
  const receipt = reconcilePublication(manifest, packages.map((item, index) => index < published ? exists(item) : absent(item)), tags(0));
  if (published === 0) assert.equal(receipt.state, "AUTHORIZED");
  else assert.notEqual(receipt.state, "AUTHORIZED");
  if (published > 0) assert.throws(() => verifyOperationReceipt(receipt, manifest, { operation: "release" }));
  if (published < packages.length && published > 0) assert.deepEqual(verifyOperationReceipt(receipt, manifest, { operation: "reconcile" }).missing, packages.slice(published).map((item) => item.name));
}

// Crash before/after each dist-tag mutation after all package bytes exist.
for (let advanced = 0; advanced <= packages.length; advanced += 1) {
  const receipt = reconcilePublication(manifest, packages.map(exists), tags(advanced), { state: "absent" });
  const recovery = verifyOperationReceipt(receipt, manifest, { operation: "reconcile" });
  assert.deepEqual(recovery.missing, []);
  assert.deepEqual(recovery.repairDistTags, packages.slice(advanced).map((item) => item.name));
}

// Crash before/after exact GitHub Release creation.
const beforeRelease = reconcilePublication(manifest, packages.map(exists), tags(3), { state: "absent" });
assert.equal(verifyOperationReceipt(beforeRelease, manifest, { operation: "reconcile" }).createGithubRelease, true);
const afterRelease = reconcilePublication(manifest, packages.map(exists), tags(3), { state: "exact", tag: `v${version}` });
assert.equal(afterRelease.phase, "post-install");
assert.equal(verifyOperationReceipt(afterRelease, manifest, { operation: "reconcile" }).createGithubRelease, false);

// A crash around tag/consumption creation never authorizes fresh publication from remote package state.
for (const marker of ["absent", "consumption-only", "both-tags"]) {
  const partial = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])], tags(0));
  assert.throws(() => verifyOperationReceipt(partial, manifest, { operation: "release" }), marker);
}
console.log("release crash matrix passed across tags, packages, dist-tags, and GitHub Release phases");
