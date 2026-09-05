import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const workflowText = readFileSync(resolve(root, ".github/workflows/npm-release.yml"), "utf8");
const workflow = parse(workflowText);
const jobs = workflow.jobs;
const ghcr = jobs["publish-ghcr"];
const manifest = jobs["publish-ghcr-manifest"];

assert.ok(ghcr, "stable GHCR build job exists");
assert.ok(manifest, "stable GHCR manifest job exists");
assert.equal(ghcr.needs, "publish");
assert.equal(ghcr["runs-on"], "${{ matrix.runner }}");
assert.equal(ghcr.environment, undefined, "GHCR build must not add another environment approval");
assert.equal(manifest.environment, undefined, "GHCR manifest must not add another environment approval");
assert.equal(ghcr.permissions.packages, "write");
assert.equal(manifest.permissions.packages, "write");
assert.deepEqual(ghcr.strategy.matrix.include, [
  { runner: "ubuntu-latest", arch: "amd64", platform: "linux/amd64" },
  { runner: "ubuntu-24.04-arm", arch: "arm64", platform: "linux/arm64" },
]);
assert.match(workflowText, /VERSION=\$\{\{ inputs\.version \}\}/);
assert.match(workflowText, /--tag \"\$IMAGE:\$VERSION\"/);
assert.match(workflowText, /imagetools inspect \"\$IMAGE:\$VERSION\" --raw/);
assert.match(workflowText, /different manifest/);
assert.doesNotMatch(workflowText, /:latest\b/);
assert.doesNotMatch(workflowText, /:next\b/);
assert.match(workflowText, /test \"\$GITHUB_SHA\" = \"\$\(git rev-parse origin\/main\)\"/);

const yamlEscapedDigitClass = /\[1-9\]\\\\d\*/;
assert.doesNotMatch(
  workflowText,
  yamlEscapedDigitClass,
  "workflow must not contain YAML-escaped \\\\d regex that rejects 0.14.1",
);

const confirm = ghcr.steps.find((step) => step.name === "Confirm exact release commit and version");
assert.ok(confirm, "GHCR confirm step exists");
assert.doesNotMatch(confirm.run, /node -e /);
assert.match(
  confirm.run,
  /node scripts\/check-npm-production-release\.mjs \"\$VERSION\"/,
  "GHCR confirm step must run the real production version check",
);
assert.match(confirm.run, /test \"\$GITHUB_SHA\" = \"\$\(git rev-parse origin\/main\)\"/);

const yamlEscapedSemver = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/;
assert.equal(yamlEscapedSemver.test("0.14.1"), false, "the old YAML-escaped regex rejects 0.14.1");

console.log("npm release contract covers native runners, one approval gate, and immutable stable GHCR tags.");
