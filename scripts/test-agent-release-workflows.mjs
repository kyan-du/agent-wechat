#!/usr/bin/env node
import { readFileSync } from "node:fs";
import YAML from "yaml";

const contract = JSON.parse(readFileSync("release/agent-release-contract.json", "utf8"));
if (contract.deploymentEnabled !== false) throw new Error("agent release deployment must remain inactive");
if (contract.channels.prerelease.environment !== "npm-prerelease" || contract.channels.stable.environment !== "npm-production") throw new Error("release environments are not separated");
if (contract.channels.prerelease.workflow === contract.channels.stable.workflow) throw new Error("inactive channel blueprints must remain independently reviewable before publisher unification");
if (contract.channels.prerelease.distTag !== "next" || contract.channels.stable.distTag !== "latest") throw new Error("release channel dist-tags drifted");
for (const [path, channel] of [[".github/workflows/npm-agent-release.yml", "prerelease"], [".github/workflows/npm-agent-stable.yml", "stable"]]) {
  const text = readFileSync(path, "utf8");
  const workflow = YAML.parse(text);
  const triggers = workflow.on ?? workflow.true;
  if (Object.keys(triggers).join(",") !== "workflow_dispatch") throw new Error(`${path}: only explicit dispatch is allowed`);
  const inputs = triggers.workflow_dispatch.inputs;
  for (const name of ["version", "release_sha", "manifest_sha256", "authorization_id", "dry_run"]) if (!inputs[name]?.required) throw new Error(`${path}: required input missing: ${name}`);
  if (channel === "prerelease" && (!inputs.operation?.required || !inputs.reconciliation_sha256)) throw new Error(`${path}: reconciliation identity inputs missing`);
  if (inputs.dry_run.default !== true) throw new Error(`${path}: dispatch must default to dry-run`);
  if (workflow.permissions?.contents !== "read" || workflow.permissions?.["id-token"] !== "none") throw new Error(`${path}: top-level inactive permissions drift`);
  const deploy = Object.entries(workflow.jobs).find(([name]) => name.startsWith("deploy-"))?.[1];
  if (!deploy || deploy.if !== "${{ false }}") throw new Error(`${path}: deployment blueprint must be statically unreachable`);
  if (deploy.permissions?.contents !== "write" || deploy.permissions?.["id-token"] !== "write") throw new Error(`${path}: future deployment capability must remain job-scoped`);
  if (path.endsWith("npm-agent-release.yml") && deploy.environment !== "npm-prerelease") throw new Error(`${path}: prerelease Environment drift`);
  if (path.endsWith("npm-agent-stable.yml") && deploy.environment !== "npm-production") throw new Error(`${path}: stable Environment drift`);
  const liveJobs = Object.fromEntries(Object.entries(workflow.jobs).filter(([name]) => !name.startsWith("deploy-")));
  if (/\bnpm publish\b|\bnpm dist-tag\b|\bgh release create\b|\bgit (?:tag|push)\b/.test(YAML.stringify(liveJobs))) throw new Error(`${path}: reachable validation job contains release side effect`);
  for (const operation of ["npm publish", "npm dist-tag add", "gh release create", "git tag -a"]) if (!YAML.stringify(deploy).includes(operation)) throw new Error(`${path}: deployment blueprint missing ${operation}`);
  if (!text.includes("deploymentEnabled!==false") || !text.includes('test "$DRY_RUN" = true')) throw new Error(`${path}: inactive fail-closed gate missing`);
  if (!text.includes('test "$GITHUB_SHA" = "$RELEASE_SHA"') || !text.includes('git merge-base --is-ancestor "$RELEASE_SHA" origin/main')) throw new Error(`${path}: exact main identity guard missing`);
}
const stable = readFileSync(".github/workflows/npm-agent-stable.yml", "utf8");
for (const field of ["source_prerelease_manifest_sha256", "canary_receipt_sha256", "npm-production"]) if (!stable.includes(field)) throw new Error(`stable separation missing: ${field}`);
const runbook = readFileSync("docs/release/AGENT-OPERATED-RELEASE.md", "utf8");
for (const statement of ["only one GitHub Actions Trusted Publisher configuration per package", "cannot simultaneously trust both", "stable publication remains unreachable"]) if (!runbook.includes(statement)) throw new Error(`single Trusted Publisher blocker is not explicit: ${statement}`);
const prerelease = readFileSync(".github/workflows/npm-agent-release.yml", "utf8");
if (!prerelease.includes("channel:") || !prerelease.includes("options: [prerelease]")) throw new Error("prerelease channel dispatch identity missing");
console.log("inactive Agent release workflow contracts passed");
