import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes } from "./agent-release-lib.mjs";
import { verifyAuthorizationReceipt } from "./release-authorization.mjs";

const commit = "1".repeat(40);
const tree = "2".repeat(40);
const version = "1.2.3";
const packages = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"].map((name) => ({
  name,
  version,
  tarball: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`,
  sha256: `sha256:${"3".repeat(64)}`,
  integrity: "sha512-AAAA",
  size: 1,
}));
const manifest = {
  schemaVersion: 1, validationOnly: true, publisherWorkflow: ".github/workflows/npm-agent-release.yml", repository: "kyan-du/agent-wechat", version,
  tag: `v${version}`, commit, tree, registry: "https://registry.npmjs.org", distTag: "latest",
  lockfile: { path: "pnpm-lock.yaml", sha256: `sha256:${"4".repeat(64)}` }, changesets: [], packages,
};
const nonce = "owner-supplied-one-time-nonce";
const manifestSha256 = `sha256:${"5".repeat(64)}`;
function receipt() {
  return {
    schemaVersion: 3, enabled: true, repository: manifest.repository,
    authorizationId: "a".repeat(32), operation: "release", reconciliationSha256: null,
    nonceSha256: sha256Bytes(Buffer.from(nonce)),
    ownerConfirmationRefSha256: `sha256:${"6".repeat(64)}`,
    issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:15:00.000Z",
    release: { tag: manifest.tag, commit, tree, manifestSha256 },
    intent: { registry: manifest.registry, distTag: manifest.distTag, packages: packages.map(({ name, version: v, tarball, sha256, integrity }) => ({ name, version: v, tarball, sha256, integrity })) },
    approvals: { owner: true, legalRedistribution: true, productionEnvironment: true, trustedPublishers: true, protectedTagRules: true, registryStateReconciled: true },
    consumption: { state: "unused", tag: `npm-release-consumed/${manifest.tag}/${"a".repeat(32)}` },
  };
}
const options = { nonce, now: "2026-08-18T00:05:00.000Z", manifestSha256, consumptionRefExists: false };

test("exact unused authorization passes", () => assert.equal(verifyAuthorizationReceipt(receipt(), manifest, options).enabled, true));
test("approved reconcile binds receipt and exact consumed marker", () => {
  const value = receipt(); value.operation = "reconcile"; value.reconciliationSha256 = `sha256:${"7".repeat(64)}`;
  assert.equal(verifyAuthorizationReceipt(value, manifest, { ...options, operation: "reconcile", reconciliationSha256: value.reconciliationSha256, consumptionRefExists: true }).enabled, true);
});
test("reconcile without prior consumption marker fails closed", () => {
  const value = receipt(); value.operation = "reconcile"; value.reconciliationSha256 = `sha256:${"7".repeat(64)}`;
  assert.throws(() => verifyAuthorizationReceipt(value, manifest, { ...options, operation: "reconcile" }), /requires the exact prior consumption marker/);
});
for (const [name, mutate, error] of [
  ["wrong nonce", (_r, o) => { o.nonce = "wrong"; }, /nonce mismatch/],
  ["expired", (_r, o) => { o.now = "2026-08-18T00:16:00.000Z"; }, /not currently valid/],
  ["overlong lifetime", (r) => { r.expiresAt = "2026-08-18T01:00:00.000Z"; }, /lifetime is invalid/],
  ["replay", (_r, o) => { o.consumptionRefExists = true; }, /already been consumed/],
  ["commit drift", (r) => { r.release.commit = "9".repeat(40); }, /release identity drift/],
  ["tree drift", (r) => { r.release.tree = "9".repeat(40); }, /release identity drift/],
  ["manifest drift", (r) => { r.release.manifestSha256 = `sha256:${"9".repeat(64)}`; }, /manifest digest drift/],
  ["artifact drift", (r) => { r.intent.packages[1].integrity = "sha512-BBBB"; }, /package integrity drift/],
  ["dist-tag drift", (r) => { r.intent.distTag = "next"; }, /must be latest/],
  ["missing approval", (r) => { r.approvals.owner = false; }, /not approved: owner/],
  ["unknown field", (r) => { r.secret = "must fail"; }, /exact schema/],
  ["consumption identity drift", (r) => { r.consumption.tag = "npm-release-consumed/wrong"; }, /invalid consumption identity/],
]) {
  test(`${name} fails closed`, () => {
    const r = receipt(); const o = { ...options }; mutate(r, o);
    assert.throws(() => verifyAuthorizationReceipt(r, manifest, o), error);
  });
}
