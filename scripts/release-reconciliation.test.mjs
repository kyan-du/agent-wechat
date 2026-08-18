import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePublication, verifyResumeReceipt } from "./release-reconciliation.mjs";

const packages = ["cli", "openclaw", "puppet"].map((suffix, index) => ({ name: `@scope/${suffix}`, version: "1.2.3-next.4", integrity: `sha512-${index}`, tarball: `${suffix}.tgz` }));
const manifest = { channel: "prerelease", version: "1.2.3-next.4", commit: "1".repeat(40), tree: "2".repeat(40), distTag: "next", packages };
const exists = (item) => ({ name: item.name, kind: "exists", version: item.version, integrity: item.integrity });
const absent = (item) => ({ name: item.name, kind: "absent" });

test("all absent starts an authorized complete publish", () => {
  const result = reconcilePublication(manifest, packages.map(absent));
  assert.equal(result.state, "AUTHORIZED");
  assert.equal(result.nextAction, "PUBLISH_ALL_EXACT_ARTIFACTS");
});

test("partial publication exposes only missing packages for an approved resume", () => {
  const result = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])]);
  assert.equal(result.state, "PARTIAL_PUBLICATION");
  assert.deepEqual(verifyResumeReceipt(result, manifest), { missing: [packages[1].name, packages[2].name], verified: [packages[0].name] });
});

test("all exact versions reconcile before dist-tag advance", () => {
  const result = reconcilePublication(manifest, packages.map(exists), { next: "1.2.3-next.3" });
  assert.equal(result.state, "RECONCILED");
  assert.equal(result.nextAction, "ADVANCE_DIST_TAGS_TOGETHER");
});

test("already advanced exact dist-tag requires verification, not republish", () => {
  const result = reconcilePublication(manifest, packages.map(exists), { next: manifest.version });
  assert.equal(result.nextAction, "VERIFY_RELEASE_AND_POST_INSTALL");
});

test("registry integrity drift abandons prerelease version", () => {
  const remote = packages.map(exists); remote[1].integrity = "sha512-wrong";
  const result = reconcilePublication(manifest, remote);
  assert.equal(result.state, "FAILED");
  assert.equal(result.nextAction, "ABANDON_VERSION_AND_PREPARE_NEXT");
  assert.throws(() => verifyResumeReceipt(result, manifest), /not safe to resume/);
});

test("registry query errors fail closed", () => assert.throws(() => reconcilePublication(manifest, [{ name: packages[0].name, kind: "error" }, ...packages.slice(1).map(absent)]), /failed closed/));
test("unknown remote evidence fails closed", () => assert.throws(() => reconcilePublication(manifest, [...packages.map(absent), { name: "@scope/unknown", kind: "absent" }]), /unexpected registry/));
test("resume identity drift fails closed", () => {
  const result = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])]);
  result.release.commit = "9".repeat(40);
  assert.throws(() => verifyResumeReceipt(result, manifest), /commit drift/);
});
