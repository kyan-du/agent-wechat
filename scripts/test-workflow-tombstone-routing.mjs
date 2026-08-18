#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const root = process.cwd();
const release = YAML.parse(readFileSync(".github/workflows/release-validation.yml", "utf8"));
const ci = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const releaseTriggers = release.on ?? release.true;
for (const event of ["pull_request", "push"]) assert.ok(releaseTriggers[event].paths.includes(".github/workflows/npm-*.yml"), `${event} tombstone routing missing`);
const filterStep = ci.jobs.changes.steps.find((step) => step.id === "filter");
assert.match(filterStep.with.filters, /ts:\n(?:.|\n)*\.github\/workflows\/npm-\*\.yml/, "CI ts tombstone routing missing");

for (const retired of ["npm-prerelease.yml", "npm-agent-stable.yml"]) {
  const dir = mkdtempSync(join(tmpdir(), "npm-workflow-tombstone-"));
  try {
    cpSync(join(root, ".github"), join(dir, ".github"), { recursive: true });
    cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
    cpSync(join(root, "release"), join(dir, "release"), { recursive: true });
    cpSync(join(root, ".changeset"), join(dir, ".changeset"), { recursive: true });
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    cpSync(join(root, "pnpm-workspace.yaml"), join(dir, "pnpm-workspace.yaml"));
    for (const pkg of ["cli", "openclaw-extension", "wechaty-puppet", "wechaty-gateway", "shared", "agent-server-rust"]) {
      mkdirSync(join(dir, "packages", pkg), { recursive: true });
      cpSync(join(root, "packages", pkg, "package.json"), join(dir, "packages", pkg, "package.json"));
    }
    writeFileSync(join(dir, ".github/workflows", retired), "name: forbidden\non:\n  push:\n    tags: ['v*']\npermissions:\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n");
    const result = spawnSync(process.execPath, ["scripts/validate-prerelease-contract.mjs"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${retired} escaped semantic validation`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log("retired npm workflow paths route to required validation and fail semantic policy");
