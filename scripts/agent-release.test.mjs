import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Bytes, sha512Integrity, validateReleaseIdentity } from "./agent-release-lib.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

const dir = mkdtempSync(join(tmpdir(), "agent-release-test-"));
const version = "1.2.3";
const names = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"];
function fixture() {
  const packages = names.map((name, index) => {
    const tarball = `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
    const bytes = Buffer.from(`artifact-${index}`);
    writeFileSync(join(dir, tarball), bytes);
    return { name, version, tarball, sha256: sha256Bytes(bytes), integrity: sha512Integrity(bytes), size: bytes.length };
  });
  return {
    schemaVersion: 1, validationOnly: true, publisherWorkflow: ".github/workflows/npm-agent-release.yml", repository: "kyan-du/agent-wechat", version,
    tag: `v${version}`, commit: "1".repeat(40), tree: "2".repeat(40), registry: "https://registry.npmjs.org", distTag: "latest",
    lockfile: { path: "pnpm-lock.yaml", sha256: `sha256:${"3".repeat(64)}` },
    changesets: [{ path: ".changeset/a.md", sha256: `sha256:${"4".repeat(64)}` }], packages,
  };
}

test.after(() => rmSync(dir, { recursive: true, force: true }));
test("only formal stable identity is accepted", () => {
  assert.equal(validateReleaseIdentity({ version, tag: `v${version}`, distTag: "latest" }).environment, "npm-production");
  assert.throws(() => validateReleaseIdentity({ version: "1.2.3-next.4", tag: "v1.2.3-next.4", distTag: "next" }), /stable version is invalid/);
  assert.throws(() => validateReleaseIdentity({ version, tag: `v${version}`, distTag: "next" }), /must be latest/);
});
test("canonical manifest passes structural verification", () => assert.equal(verifyReleaseManifest(fixture()).version, version));
test("unknown manifest keys fail closed", () => { const value = fixture(); value.extra = true; assert.throws(() => verifyReleaseManifest(value), /exact schema/); });
test("package order drift fails closed", () => { const value = fixture(); value.packages.reverse(); assert.throws(() => verifyReleaseManifest(value), /identity\/version drift/); });
test("artifact byte drift fails closed", () => {
  const value = fixture(); writeFileSync(join(dir, value.packages[0].tarball), "tampered");
  assert.throws(() => verifyReleaseManifest(value, { artifactDir: dir }), /integrity mismatch/);
});
