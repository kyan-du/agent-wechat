#!/usr/bin/env node
import { readFileSync } from "node:fs";
import YAML from "yaml";

const publisherPath = ".github/workflows/npm-release.yml";
const contract = JSON.parse(readFileSync("release/agent-release-contract.json", "utf8"));
if (contract.deploymentEnabled !== false) throw new Error("formal release deployment must remain inactive");
if (contract.publisherWorkflow !== publisherPath || contract.environment !== "npm-production") throw new Error("single production publisher identity drift");
if (contract.distTag !== "latest" || contract.githubPrerelease !== false) throw new Error("formal latest/final Release contract drift");
if (!(new RegExp(contract.versionPattern)).test("1.2.3") || (new RegExp(contract.versionPattern)).test("1.2.3-next.4")) throw new Error("stable-only version grammar drift");

const text = readFileSync(publisherPath, "utf8");
const workflow = YAML.parse(text);
const triggers = workflow.on ?? workflow.true;
if (Object.keys(triggers).join(",") !== "workflow_dispatch") throw new Error("production publisher must be explicit-dispatch only");
const inputs = triggers.workflow_dispatch.inputs;
for (const name of ["version", "release_sha", "manifest_sha256", "authorization_id", "operation", "reconciliation_sha256", "dry_run"]) if (!(name in inputs)) throw new Error(`publisher input missing: ${name}`);
for (const forbidden of ["channel", "source_prerelease_manifest_sha256", "canary_receipt_sha256"]) if (forbidden in inputs) throw new Error(`retired prerelease input remains: ${forbidden}`);
if (inputs.dry_run.required !== true || inputs.dry_run.default !== true) throw new Error("publisher dispatch must require dry-run");
if (workflow.permissions?.contents !== "read" || workflow.permissions?.["id-token"] !== "none") throw new Error("inactive top-level permissions drift");
const candidate = workflow.jobs?.candidate, deploy = workflow.jobs?.deploy;
if (!candidate || !deploy || deploy.if !== "${{ false }}" || deploy.environment !== "npm-production") throw new Error("inactive npm-production blueprint drift");
if (deploy.permissions?.contents !== "write" || deploy.permissions?.["id-token"] !== "write") throw new Error("future production capability must remain job-scoped");
const liveJobs = Object.fromEntries(Object.entries(workflow.jobs).filter(([name]) => name !== "deploy"));
if (/\bnpm publish\b|\bnpm dist-tag\b|\bgh release create\b|\bgit (?:tag|push)\b/.test(YAML.stringify(liveJobs))) throw new Error("reachable validation contains release side effect");
const candidateText = YAML.stringify(candidate), deployText = YAML.stringify(deploy);
for (const proof of ["prepare-agent-release.mjs", "verify-agent-release.mjs", "cmp ", "diff -qr", "artifact-id", "artifact-digest", "npm-production-${VERSION}-${RELEASE_SHA}"]) if (!text.includes(proof)) throw new Error(`candidate intent proof missing: ${proof}`);
for (const operation of ["npm publish", "npm dist-tag add", "latest", "ensure-github-release.mjs", "consume-release-authorization.mjs", "verify-release-operation.mjs", "verify-agent-release.mjs", "--skip-consumption-lookup", "vars.NPM_AUTHORIZATION_SHA", "vars.NPM_AUTHORIZATION_TAG_OID"]) if (!deployText.includes(operation)) throw new Error(`production blueprint missing ${operation}`);
const authorizationStep = deploy.steps.find((step) => String(step.name).includes("authenticate authorization"));
for (const name of ["NPM_AUTHORIZATION_SHA", "NPM_AUTHORIZATION_TAG_OID"]) if (!authorizationStep?.env?.[name] || !String(authorizationStep.run).includes(`\"$${name}\" | grep -Eq '^[0-9a-f]{40}$'`)) throw new Error(`effective production authorization context missing ${name}`);
if (/--prerelease|\bnext\b|next\.|npm-prerelease|inputs\.channel|verify-stable-promotion/.test(text)) throw new Error("prerelease/promotion path remains in production publisher");
if (!text.includes("'^[0-9]+\\.[0-9]+\\.[0-9]+$'")) throw new Error("formal stable version guard missing");

const retiredText = readFileSync(".github/workflows/npm-agent-stable.yml", "utf8");
const retired = YAML.parse(retiredText);
if ((retired.permissions?.["id-token"] ?? "none") !== "none" || /npm publish|npm dist-tag|gh release create|contents:\s*write|id-token:\s*write/.test(retiredText)) throw new Error("retired second workflow claims release capability");

const runbook = readFileSync("docs/release/AGENT-OPERATED-RELEASE.md", "utf8");
for (const statement of ["stable-only", "npm-production", "latest", "no npm prerelease", "atomic", "provenance"]) if (!runbook.includes(statement)) throw new Error(`stable-only runbook missing: ${statement}`);
console.log("inactive stable-only Agent release contracts passed");
