import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Bytes } from "./agent-release-lib.mjs";
import { reconcilePublication } from "./release-reconciliation.mjs";

const script = join(import.meta.dirname, "select-npm-release-artifacts.mjs");
const dir = mkdtempSync(join(tmpdir(), "select-release-artifacts-"));
const version = "1.2.3-next.4";
const names = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"];
const packages = names.map((name, index) => ({ name, version, tarball: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`, sha256: `sha256:${String(index + 1).repeat(64)}`, integrity: `sha512-${index}`, size: 1 }));
const manifest = { schemaVersion: 1, validationOnly: true, repository: "kyan-du/agent-wechat", publisherWorkflow: ".github/workflows/npm-agent-release.yml", channel: "prerelease", version, tag: `v${version}`, commit: "1".repeat(40), tree: "2".repeat(40), registry: "https://registry.npmjs.org", distTag: "next", lockfile: { path: "pnpm-lock.yaml", sha256: `sha256:${"4".repeat(64)}` }, changesets: [], packages };
const exists = (item) => ({ name: item.name, kind: "exists", version: item.version, integrity: item.integrity, provenance: { state: "verified", repository: manifest.repository, workflow: manifest.publisherWorkflow, commit: manifest.commit } });
const absent = (item) => ({ name: item.name, kind: "absent" });

function select(receipt, operation, digest) {
  const manifestPath = join(dir, `manifest-${Math.random()}.json`);
  const receiptPath = join(dir, `receipt-${Math.random()}.json`);
  const output = join(dir, `output-${Math.random()}.txt`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const receiptRaw = Buffer.from(JSON.stringify(receipt)); writeFileSync(receiptPath, receiptRaw);
  const args = [script, "--manifest", manifestPath, "--reconciliation", receiptPath, "--operation", operation];
  if (operation === "reconcile") args.push("--reconciliation-sha256", digest ?? sha256Bytes(receiptRaw));
  args.push("--output", output);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { result, output };
}

test.after(() => rmSync(dir, { recursive: true, force: true }));
test("fresh release cannot select artifacts from partial state", () => {
  const receipt = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])]);
  assert.notEqual(select(receipt, "release").result.status, 0);
});
test("explicit reconciliation selects missing only", () => {
  const receipt = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])]);
  const { result, output } = select(receipt, "reconcile");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), `${packages[1].tarball}\n${packages[2].tarball}\n`);
});
test("all package bytes safely yields an empty publish list", () => {
  const receipt = reconcilePublication(manifest, packages.map(exists));
  const { result, output } = select(receipt, "reconcile");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), "");
});
test("wrong reconciliation digest fails closed", () => {
  const receipt = reconcilePublication(manifest, [exists(packages[0]), absent(packages[1]), absent(packages[2])]);
  assert.notEqual(select(receipt, "reconcile", `sha256:${"9".repeat(64)}`).result.status, 0);
});
