import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePublication, reconciliationDigest, verifyOperationReceipt } from "./release-reconciliation.mjs";

const packages = ["cli", "openclaw", "puppet"].map((suffix, index) => ({ name: `@scope/${suffix}`, version: "1.2.3-next.4", integrity: `sha512-${index}`, tarball: `${suffix}.tgz` }));
const manifest = { publisherWorkflow: ".github/workflows/npm-agent-release.yml", channel: "prerelease", version: "1.2.3-next.4", commit: "1".repeat(40), tree: "2".repeat(40), distTag: "next", packages };
const exists = (item) => ({ name: item.name, kind: "exists", version: item.version, integrity: item.integrity, provenance: { state: "verified", repository: "kyan-du/agent-wechat", workflow: manifest.publisherWorkflow, commit: manifest.commit } });
const absent = (item) => ({ name: item.name, kind: "absent" });
const tags = (count) => Object.fromEntries(packages.map((item, index) => [item.name, index < count ? manifest.version : "1.2.3-next.3"]));

test("fresh release requires all packages absent", () => {
  const receipt = reconcilePublication(manifest, packages.map(absent), tags(0));
  assert.equal(receipt.state, "AUTHORIZED");
  assert.equal(receipt.phase, "packages");
  assert.deepEqual(verifyOperationReceipt(receipt, manifest, { operation: "release" }).missing, packages.map((item) => item.name));
});

test("fresh release rejects every partial package crash point", () => {
  for (let count = 1; count < packages.length; count += 1) {
    const receipt = reconcilePublication(manifest, packages.map((item, index) => index < count ? exists(item) : absent(item)), tags(0));
    assert.equal(receipt.state, "PARTIAL_PUBLICATION");
    assert.throws(() => verifyOperationReceipt(receipt, manifest, { operation: "release" }), /fresh release requires all exact package versions to be absent/);
    assert.deepEqual(verifyOperationReceipt(receipt, manifest, { operation: "reconcile" }).missing, packages.slice(count).map((item) => item.name));
  }
});

test("reconciliation binds the exact receipt digest", () => {
  const receipt = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])], tags(0));
  const digest = reconciliationDigest(receipt);
  assert.deepEqual(verifyOperationReceipt(receipt, manifest, { operation: "reconcile", expectedDigest: digest }).verified, [packages[0].name]);
  assert.throws(() => verifyOperationReceipt(receipt, manifest, { operation: "reconcile", expectedDigest: `sha256:${"9".repeat(64)}` }), /digest drift/);
});

test("all package bytes with interrupted dist-tags skips publish and repairs only missing mappings", () => {
  for (let count = 0; count < packages.length; count += 1) {
    const receipt = reconcilePublication(manifest, packages.map(exists), tags(count));
    assert.equal(receipt.phase, "dist-tags");
    const recovery = verifyOperationReceipt(receipt, manifest, { operation: "reconcile" });
    assert.deepEqual(recovery.missing, []);
    assert.deepEqual(recovery.repairDistTags, packages.slice(count).map((item) => item.name));
  }
});

test("complete dist-tags with missing Release advances to idempotent Release creation", () => {
  const receipt = reconcilePublication(manifest, packages.map(exists), tags(3), { state: "absent" });
  assert.equal(receipt.phase, "github-release");
  assert.equal(verifyOperationReceipt(receipt, manifest, { operation: "reconcile" }).createGithubRelease, true);
});

test("exact GitHub Release advances to post-install without republish", () => {
  const receipt = reconcilePublication(manifest, packages.map(exists), tags(3), { state: "exact", tag: manifest.tag });
  assert.equal(receipt.phase, "post-install");
  assert.deepEqual(verifyOperationReceipt(receipt, manifest, { operation: "reconcile" }).missing, []);
});

test("missing provenance can never count as verified existing bytes", () => {
  const withoutProvenance = packages.map(exists); delete withoutProvenance[0].provenance;
  assert.equal(reconcilePublication(manifest, withoutProvenance, tags(3)).state, "FAILED");
});

test("registry integrity, provenance, or GitHub Release identity drift fails closed", () => {
  const integrityDrift = packages.map(exists); integrityDrift[1].integrity = "sha512-wrong";
  assert.equal(reconcilePublication(manifest, integrityDrift, tags(3)).state, "FAILED");
  const provenanceDrift = packages.map(exists); provenanceDrift[1].provenance.commit = "9".repeat(40);
  assert.equal(reconcilePublication(manifest, provenanceDrift, tags(3)).state, "FAILED");
  assert.equal(reconcilePublication(manifest, packages.map(exists), tags(3), { state: "drift" }).state, "FAILED");
});

test("registry query and unknown evidence fail closed", () => {
  assert.throws(() => reconcilePublication(manifest, [{ name: packages[0].name, kind: "error" }, ...packages.slice(1).map(absent)]), /failed closed/);
  assert.throws(() => reconcilePublication(manifest, [...packages.map(absent), { name: "@scope/unknown", kind: "absent" }]), /unexpected registry/);
});

test("reconciliation release identity drift fails closed", () => {
  const receipt = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])], tags(0));
  receipt.release.commit = "9".repeat(40);
  assert.throws(() => verifyOperationReceipt(receipt, manifest, { operation: "reconcile" }), /commit drift/);
});
