#!/usr/bin/env node
import { readFileSync } from "node:fs";
import YAML from "yaml";

const publisherPath = ".github/workflows/npm-agent-release.yml";
const stableValidationPath = ".github/workflows/npm-agent-stable.yml";
const contract = JSON.parse(readFileSync("release/agent-release-contract.json", "utf8"));
if (contract.deploymentEnabled !== false) throw new Error("Agent release deployment must remain inactive");
if (contract.publisherWorkflow !== publisherPath) throw new Error("each npm package must bind one exact publisher workflow identity");
if (contract.channels.prerelease.environment !== "npm-prerelease" || contract.channels.stable.environment !== "npm-production") throw new Error("release Environments are not separated");
if (contract.channels.prerelease.distTag !== "next" || contract.channels.stable.distTag !== "latest") throw new Error("release channel dist-tags drifted");
if (contract.channels.stable.requiresCanaryProvenance !== true) throw new Error("stable canary provenance is not mandatory");

const publisherText = readFileSync(publisherPath, "utf8");
const publisher = YAML.parse(publisherText);
const publisherTriggers = publisher.on ?? publisher.true;
if (Object.keys(publisherTriggers).join(",") !== "workflow_dispatch") throw new Error("publisher must be explicit-dispatch only");
const publisherInputs = publisherTriggers.workflow_dispatch.inputs;
for (const name of ["channel", "version", "release_sha", "manifest_sha256", "authorization_id", "operation", "reconciliation_sha256", "source_prerelease_manifest_sha256", "canary_receipt_sha256", "dry_run"]) {
  if (!(name in publisherInputs)) throw new Error(`publisher input missing: ${name}`);
}
if (JSON.stringify(publisherInputs.channel.options) !== JSON.stringify(["prerelease", "stable"])) throw new Error("single publisher must expose exactly prerelease/stable channels");
if (publisherInputs.dry_run.required !== true || publisherInputs.dry_run.default !== true) throw new Error("publisher dispatch must require dry-run");
if (publisher.permissions?.contents !== "read" || publisher.permissions?.["id-token"] !== "none") throw new Error("inactive publisher top-level permissions drift");
const candidate = publisher.jobs?.candidate;
if (!candidate || !candidate.steps.some((step) => step.uses === "actions/upload-artifact@v4" && step.with?.name === "npm-release-${{ inputs.release_sha }}")) throw new Error("deterministic candidate artifact upload is missing");
const candidateText = YAML.stringify(candidate);
for (const proof of ["prepare-agent-release.mjs", "verify-agent-release.mjs", "cmp ", "diff -qr", "MANIFEST_SHA256"]) if (!candidateText.includes(proof)) throw new Error(`candidate sealing proof missing: ${proof}`);
const deploy = publisher.jobs?.deploy;
if (!deploy || deploy.if !== "${{ false }}") throw new Error("publisher deployment blueprint must be statically unreachable");
if (deploy.permissions?.contents !== "write" || deploy.permissions?.["id-token"] !== "write") throw new Error("future publisher capability must remain job-scoped");
if (deploy.environment?.name !== "${{ inputs.channel == 'stable' && 'npm-production' || 'npm-prerelease' }}") throw new Error("channel-to-Environment selection drift");
const livePublisherJobs = Object.fromEntries(Object.entries(publisher.jobs).filter(([name]) => name !== "deploy"));
if (/\bnpm publish\b|\bnpm dist-tag\b|\bgh release create\b|\bgit (?:tag|push)\b/.test(YAML.stringify(livePublisherJobs))) throw new Error("reachable publisher validation contains a release side effect");
const blueprint = YAML.stringify(deploy);
for (const operation of ["npm publish", "npm dist-tag add", "gh release create", "git tag -a", "verify-stable-promotion.mjs", "verify-release-operation.mjs", "consume-release-authorization.mjs", "verify-agent-release.mjs", "--skip-consumption-lookup"]) {
  if (!blueprint.includes(operation)) throw new Error(`single publisher blueprint missing ${operation}`);
}
for (const guard of [
  'test "$DRY_RUN" = true',
  'test "$GITHUB_SHA" = "$RELEASE_SHA"',
  'git merge-base --is-ancestor "$RELEASE_SHA" origin/main',
  'case "$CHANNEL" in',
  'prerelease)',
  'stable)',
  'inputs.channel == \'stable\'',
]) if (!publisherText.includes(guard)) throw new Error(`single publisher channel guard missing: ${guard}`);

const stableText = readFileSync(stableValidationPath, "utf8");
const stableWorkflow = YAML.parse(stableText);
const stableTriggers = stableWorkflow.on ?? stableWorkflow.true;
if (Object.keys(stableTriggers).join(",") !== "workflow_dispatch") throw new Error("stable contract validation must be manual-only");
if (stableWorkflow.permissions?.contents !== "read" || stableWorkflow.permissions?.["id-token"] !== "none") throw new Error("stable contract validation permissions drift");
if (Object.values(stableWorkflow.jobs ?? {}).some((job) => job.permissions?.contents === "write" || job.permissions?.["id-token"] === "write")) throw new Error("second workflow must not claim publisher capability");
if (/\bnpm publish\b|\bnpm dist-tag\b|\bgh release create\b|\bgit (?:tag|push)\b/.test(stableText)) throw new Error("second workflow retained registry/tag/Release write blueprint");
for (const field of ["source_prerelease_manifest_sha256", "canary_receipt_sha256", publisherPath]) if (!stableText.includes(field)) throw new Error(`stable validation boundary missing: ${field}`);

const runbook = readFileSync("docs/release/AGENT-OPERATED-RELEASE.md", "utf8");
for (const statement of ["one GitHub Actions Trusted Publisher configuration per package", "one npm-trusted publisher workflow", "channel=stable", "npm-production", "atomic", "provenance"]) {
  if (!runbook.includes(statement)) throw new Error(`single Trusted Publisher design is not explicit: ${statement}`);
}
console.log("inactive single-publisher Agent release contracts passed");
