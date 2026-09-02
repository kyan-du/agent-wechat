#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" });
const fail = (message) => { throw new Error(message); };
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const contract = readJson("release/prerelease-contract.json");
if (contract.npmDistTag !== "next" || contract.versionPrerelease !== "next") fail("prerelease contract must use next exclusively");
if (!contract.forbiddenDistTags?.includes("latest")) fail("prerelease contract must explicitly forbid latest");
if (contract.externalSideEffects !== true) fail("approved prerelease publication must remain explicit");
if (!same(contract.requiredApprovals ?? [], ["owner", "legalRedistribution"])) fail("owner and legal/redistribution approvals must remain hard gates");

const workspaceList = JSON.parse(run("pnpm", ["-r", "list", "--depth", "-1", "--json"]));
const workspaces = new Map();
for (const entry of workspaceList) {
  const manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"));
  if (!manifest.name) fail(`workspace lacks name: ${relative(root, entry.path)}`);
  workspaces.set(manifest.name, manifest);
}
const publishable = [...workspaces.values()].filter((manifest) => manifest.private !== true).map((manifest) => manifest.name);
const privatePackages = [...workspaces.values()].filter((manifest) => manifest.private === true).map((manifest) => manifest.name);
if (!same(publishable, contract.publicPackages)) fail(`publishable workspace drift: ${publishable.join(", ")}`);
const auditedPrivate = privatePackages.filter((name) => name !== "agent-wechat" && name !== "@kyan-du/agent-wechat-docs");
if (!same(auditedPrivate, contract.privatePackages)) fail(`private workspace drift: ${privatePackages.join(", ")}`);
for (const name of contract.publicPackages) {
  const manifest = workspaces.get(name);
  if (!manifest || manifest.private === true) fail(`${name} is not publishable`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) fail(`${name} must retain public/provenance publish metadata`);
}
for (const name of contract.privatePackages) if (workspaces.get(name)?.private !== true) fail(`${name} must remain private`);

const changesetConfig = readJson(".changeset/config.json");
if (changesetConfig.privatePackages?.tag !== false) fail("Changesets must never tag private packages");
if (changesetConfig.privatePackages?.version !== true) fail("Changesets must keep private version coupling explicit");
if (changesetConfig.fixed?.length !== 1 || !same(changesetConfig.fixed[0], contract.fixedWorkspaceGroup)) fail("Changesets fixed-group topology drift");
const fixedPrivate = changesetConfig.fixed[0].filter((name) => workspaces.get(name)?.private === true);
if (!fixedPrivate.length) fail("expected explicit private workspace coupling in fixed group");

const changesetFiles = readdirSync(join(root, ".changeset")).filter((name) => name.endsWith(".md") && name !== "README.md").sort();
const referenced = new Set();
for (const file of changesetFiles) {
  const text = readFileSync(join(root, ".changeset", file), "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) fail(`invalid changeset frontmatter: ${file}`);
  const document = parseDocument(frontmatter, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length) fail(`invalid changeset YAML ${file}: ${document.errors[0].message}`);
  if (!document.contents || document.contents.type !== undefined || !Array.isArray(document.contents.items)) fail(`changeset frontmatter must be a mapping: ${file}`);
  const entries = document.contents.items;
  if (!entries.length) fail(`changeset frontmatter is empty: ${file}`);
  for (const pair of entries) {
    if (!pair || !pair.key || !pair.value || typeof pair.key.value !== "string" || typeof pair.value.value !== "string") fail(`unsupported changeset entry in ${file}`);
    const name = pair.key.value;
    const bump = pair.value.value;
    if (!workspaces.has(name)) fail(`${file} references unknown workspace ${name}`);
    if (!new Set(["patch", "minor", "major"]).has(bump)) fail(`${file} has invalid bump ${JSON.stringify(bump)} for ${name}`);
    referenced.add(name);
  }
}
if (changesetFiles.length && !changesetConfig.fixed[0].some((name) => referenced.has(name))) fail("pending changesets do not exercise the fixed release group");
for (const name of contract.publicPackages) if (!changesetConfig.fixed[0].includes(name)) fail(`fixed prerelease topology omits public package ${name}`);

const forbidden = [];
const workflowDir = join(root, ".github", "workflows");
for (const name of readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))) {
  const path = join(workflowDir, name);
  const text = readFileSync(path, "utf8");
  let workflow;
  try { workflow = parseYaml(text); } catch (error) { fail(`${name}: invalid workflow YAML: ${error.message}`); }
  const trigger = workflow.on ?? workflow.true ?? {};
  for (const [event, config] of Object.entries(trigger)) {
    if (event === "push" && config && typeof config === "object" && ("tags" in config || "tags-ignore" in config)) forbidden.push(`${name}: tag trigger`);
  }
  const checkPermissions = (permissions, where, job) => {
    if (permissions === "write-all") forbidden.push(`${name}: ${where} write-all permission`);
    if (!permissions || typeof permissions !== "object") return;
    for (const scope of ["packages", "contents", "id-token"]) {
      const inertBlueprint = name === "npm-release.yml" && where === "job publish" && job?.environment === "npm-production";
      const stableGhcrRelease = name === "npm-release.yml" &&
        ["job publish-ghcr", "job publish-ghcr-manifest"].includes(where) &&
        job?.needs !== undefined;
      const approvedWrite = (["ghcr-prerelease.yml", "docker-commit-verification.yml"].includes(name) && where === "workflow" && scope === "packages")
        || (name === "deploy-docs.yml" && where === "workflow" && scope === "id-token")
        || inertBlueprint
        || (stableGhcrRelease && scope === "packages");
      if (permissions[scope] === "write" && !approvedWrite) forbidden.push(`${name}: ${where} ${scope} write permission`);
    }
  };
  checkPermissions(workflow.permissions, "workflow");
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    checkPermissions(job?.permissions, `job ${jobName}`, job);
    for (const step of job?.steps ?? []) {
      const uses = String(step?.uses ?? "");
      const command = String(step?.run ?? "");
      const stableGhcrJob = name === "npm-release.yml" &&
        ["publish-ghcr", "publish-ghcr-manifest"].includes(jobName) &&
        job?.needs !== undefined;
      if (/docker\/login-action/i.test(uses) && !["ghcr-prerelease.yml", "docker-commit-verification.yml"].includes(name) && !stableGhcrJob) forbidden.push(`${name}: registry login action`);
      if (/softprops\/action-gh-release|actions\/create-release/i.test(uses)) forbidden.push(`${name}: GitHub Release action`);
      if (/docker\/build-push-action/i.test(uses) && step?.with?.push === true && !["ghcr-prerelease.yml", "docker-commit-verification.yml"].includes(name) && !stableGhcrJob) forbidden.push(`${name}: image push action`);
      const commands = [
        [/\b(?:npm|pnpm)\s+publish\b/i, "npm publish"],
        [/\bchangeset\s+publish\b/i, "changeset publish"],
        [/\bgh\s+release\s+create\b/i, "GitHub Release creation"],
        [/\bgit\s+(?:tag|push\s+[^\n]*--tags)\b/i, "tag creation/push"],
        [/\bdocker\s+(?:push|buildx\s+build[^\n]*--push)\b/i, "image push"],
      ];
      for (const [pattern, label] of commands) {
        const approvedPublish = (["ghcr-prerelease.yml", "docker-commit-verification.yml"].includes(name) && label === "image push")
          || (name === "npm-release.yml" && (jobName === "publish" && job?.environment === "npm-production" || stableGhcrJob));
        if (pattern.test(command) && !approvedPublish) forbidden.push(`${name}: ${label}`);
      }
    }
  }
}
const releaseWorkflow = parseYaml(readFileSync(join(workflowDir, "release-validation.yml"), "utf8"));
const releaseTriggers = releaseWorkflow.on ?? releaseWorkflow.true ?? {};
for (const event of ["pull_request", "push", "workflow_dispatch"]) if (!(event in releaseTriggers)) fail(`release validation workflow must exercise ${event}`);
if (forbidden.length) fail(`workflow publication capability detected:\n${forbidden.join("\n")}`);

const agentReleaseContract = readJson("release/agent-release-contract.json");
if (agentReleaseContract.deploymentEnabled !== true) fail("Agent-operated release must remain active");
const npmText = readFileSync(join(workflowDir, "npm-release.yml"), "utf8");
const npmReleaseUtilsText = readFileSync(join(root, "scripts", "npm-release-utils.mjs"), "utf8");
const npmWorkflow = parseYaml(npmText);
const npmTriggers = npmWorkflow.on ?? npmWorkflow.true ?? {};
if (JSON.stringify(Object.keys(npmTriggers)) !== JSON.stringify(["workflow_dispatch"])) fail("npm-release.yml: only explicit dispatch is allowed");
const npmInputs = npmTriggers.workflow_dispatch?.inputs ?? {};
if (JSON.stringify(Object.keys(npmInputs)) !== JSON.stringify(["version"])) fail(`npm-release.yml: expected only version input, found ${Object.keys(npmInputs).join(", ")}`);
if (workflowDir && /release_sha|reconciliation_sha256|artifact_id|artifact-digest|reconcile-npm-release|prepare-agent-release/.test(npmText)) {
  fail("npm-release.yml: obsolete manifest/artifact/reconcile machinery remains");
}
if (npmWorkflow.permissions?.contents !== "read" || npmWorkflow.permissions?.["id-token"] !== "none") fail("npm-release.yml: top-level permissions drift");
const verify = npmWorkflow.jobs?.verify;
const publish = npmWorkflow.jobs?.publish;
if (!verify || !publish || publish?.if !== undefined || publish?.environment !== "npm-production") fail("npm-release.yml: production Environment boundary drift");
if (publish.permissions?.contents !== "write" || publish.permissions?.["id-token"] !== "write") fail("npm-release.yml: production write permissions must remain environment-gated");
for (const required of [
  "git rev-parse origin/main",
  "test \"$GITHUB_SHA\" = \"$main_sha\"",
  "--workflow CI",
  "check-npm-production-release.mjs",
  "npm pack ./packages/cli",
  "npm pack ./packages/openclaw-extension",
  "npm pack ./packages/wechaty-puppet",
  "upload-artifact@",
  "include-hidden-files: true",
  "environment: npm-production",
  "npm-release-utils.mjs publish-existing-safe",
  "verify-published-npm-release.mjs",
  "refs/tags/$tag",
  "gh release create",
]) if (!npmText.includes(required)) fail(`npm-release.yml: missing ${required}`);
for (const required of [
  "npm publish",
  "--provenance",
  "verifyTarballIntegrity",
  "already exists on npm with different content",
]) if (!npmReleaseUtilsText.includes(required)) fail(`npm-release-utils.mjs: missing ${required}`);
const rootManifest = readJson("package.json");
if (rootManifest.scripts?.release) fail("validation-only repository must not expose a release/publish script");
if (!existsSync(join(root, "docs", "release", "P1-B1-RUNBOOK.md")) || !existsSync(join(root, "docs", "release", "AGENT-OPERATED-RELEASE.md"))) fail("release runbook is missing");

if (agentReleaseContract.environment !== "npm-production" || agentReleaseContract.distTag !== "latest" || agentReleaseContract.githubPrerelease !== false) fail("formal production release identity drift");
if (!same(agentReleaseContract.publicPackages.map((item) => item.name), contract.publicPackages)) fail("formal production package set drift");
if (/next|prerelease/i.test(JSON.stringify({ environment: agentReleaseContract.environment, versionPattern: agentReleaseContract.versionPattern, distTag: agentReleaseContract.distTag }))) fail("Agent release contract retained prerelease identity");
const releaseWorkflows = readdirSync(workflowDir).filter((name) => /release/i.test(name)).sort();
if (JSON.stringify(releaseWorkflows) !== JSON.stringify(["ghcr-prerelease.yml", "npm-release.yml", "release-validation.yml"])) fail(`unexpected release workflows: ${releaseWorkflows.join(", ")}`);
console.log(`release contracts valid: one stable-only npm publisher for ${contract.publicPackages.length} public packages`);
