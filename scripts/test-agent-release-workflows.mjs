#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import YAML from "yaml";
const publisherPath = ".github/workflows/npm-release.yml";
const contract = JSON.parse(readFileSync("release/agent-release-contract.json", "utf8"));
if (contract.deploymentEnabled !== true) throw new Error("formal release deployment must be active");
if (contract.publisherWorkflow !== publisherPath || contract.environment !== "npm-production") throw new Error("single production publisher identity drift");
if (contract.distTag !== "latest" || contract.githubPrerelease !== false) throw new Error("formal latest/final Release contract drift");
const text = readFileSync(publisherPath, "utf8"), workflow = YAML.parse(text), triggers = workflow.on ?? workflow.true;
if (Object.keys(triggers).join(",") !== "workflow_dispatch") throw new Error("production publisher must be explicit-dispatch only");
const inputs = triggers.workflow_dispatch.inputs;
for (const name of ["version", "release_sha", "operation", "reconciliation_sha256"]) if (!(name in inputs)) throw new Error(`publisher input missing: ${name}`);
for (const forbidden of ["authorization_id", "dry_run", "channel", "manifest_sha256", "source_prerelease_manifest_sha256", "canary_receipt_sha256"]) if (forbidden in inputs) throw new Error(`obsolete input remains: ${forbidden}`);
if (workflow.permissions?.contents !== "read" || workflow.permissions?.["id-token"] !== "none") throw new Error("top-level least privilege drift");
const candidate=workflow.jobs?.candidate, deploy=workflow.jobs?.deploy;
if (!candidate || !deploy || deploy.if !== undefined || deploy.environment !== "npm-production") throw new Error("reachable npm-production deployment drift");
if (deploy.permissions?.contents !== "write" || deploy.permissions?.["id-token"] !== "write") throw new Error("production capability must remain job-scoped");
const candidateText=YAML.stringify(candidate), deployText=YAML.stringify(deploy);
const splitUploadPaths = (value) => String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const globBase = (path) => {
  const parts = path.split("/");
  const globIndex = parts.findIndex((part) => /[*?\[]/.test(part));
  return globIndex < 0 ? posix.dirname(path) : parts.slice(0, globIndex).join("/");
};
const commonAncestor = (paths) => {
  const [first, ...rest] = paths.map((path) => path.split("/"));
  const common = [];
  for (let index = 0; index < first.length; index += 1) {
    if (!rest.every((parts) => parts[index] === first[index])) break;
    common.push(first[index]);
  }
  return common.join("/");
};
const uploadStep = candidate.steps.find((step) => step.id === "upload");
const downloadStep = deploy.steps.find((step) => String(step.uses ?? "").includes("actions/download-artifact@"));
if (!uploadStep?.with?.path || !downloadStep?.with) throw new Error("candidate upload or deploy download step missing");
const uploadPaths = splitUploadPaths(uploadStep.with.path);
const payloadRoot = commonAncestor(uploadPaths.map(globBase));
const payloadEntries = uploadPaths.map((path) => posix.relative(payloadRoot, path)).sort();
if (payloadRoot !== ".release-candidate") throw new Error(`release artifact payload root drift: ${payloadRoot}`);
if (JSON.stringify(payloadEntries) !== JSON.stringify(["agent-release-manifest.json", "tarballs/*.tgz"])) throw new Error(`release artifact payload entries drift: ${payloadEntries.join(", ")}`);
const materializedEntries = payloadEntries.map((entry) => posix.join(downloadStep.with.path, downloadStep.with["merge-multiple"] === true ? entry : "<artifact-name>", downloadStep.with["merge-multiple"] === true ? "" : entry).replace(/\/$/, ""));
for (const expected of [".release-candidate/agent-release-manifest.json", ".release-candidate/tarballs/*.tgz"]) {
  if (!materializedEntries.includes(expected)) throw new Error(`downloaded candidate layout cannot satisfy ${expected}; got ${materializedEntries.join(", ")}`);
}
for (const proof of ["prepare-agent-release.mjs","verify-agent-release.mjs","cmp ","diff -qr","artifact-id","artifact-digest","artifact_name=npm-production-%s-%s-%s"]) if (!text.includes(proof)) throw new Error(`candidate intent proof missing: ${proof}`);
if (!candidate.outputs?.manifest_sha256?.includes("steps.seal.outputs.manifest_sha256")) throw new Error("candidate must expose its generated manifest digest");
if (!candidateText.includes("sha256Bytes(readFileSync(process.argv[1]))")) throw new Error("candidate must hash the runner-generated manifest");
if (candidateText.includes("--manifest-sha256 \"$MANIFEST_SHA256\"")) throw new Error("candidate must not require a dispatch manifest digest");
const deployVerify = deploy.steps.find((step) => step.name === "Re-hash sealed production candidate without rebuilding");
if (!deployVerify?.run?.includes('--manifest-sha256 "${{ needs.candidate.outputs.manifest_sha256 }}"')) throw new Error("deploy must re-hash against the sealed candidate digest");
for (const operation of ["npm publish","npm dist-tag add","latest","ensure-github-release.mjs","verify-release-operation.mjs","verify-agent-release.mjs","reconcile-npm-release.mjs","--provenance"]) if (!deployText.includes(operation)) throw new Error(`production workflow missing ${operation}`);
if (!deployText.includes("pnpm/action-setup@") || !deployText.includes("pnpm install --frozen-lockfile")) throw new Error("deploy job must install release script dependencies before re-hashing sealed artifacts");
if (/npm-release-authorization|authorization_id|atomic-cas-required|NPM_AUTHORIZATION/.test(text)) throw new Error("unsupported external authorization/CAS remains");
if (!text.includes("'^[0-9]+\\.[0-9]+\\.[0-9]+$'")) throw new Error("formal stable version guard missing");
const npmWorkflows=readdirSync(".github/workflows").filter(n=>/^npm-.*\.ya?ml$/.test(n)).sort();
if (JSON.stringify(npmWorkflows)!==JSON.stringify(["npm-release.yml"])) throw new Error(`unexpected npm workflows: ${npmWorkflows.join(", ")}`);
const runbook=readFileSync("docs/release/AGENT-OPERATED-RELEASE.md","utf8");
for (const statement of ["stable-only","npm-production","latest","partial publication","provenance"]) if (!runbook.includes(statement)) throw new Error(`runbook missing: ${statement}`);
console.log("active stable-only Agent release contract passed");
