#!/usr/bin/env node
import { readFileSync } from "node:fs";
import YAML from "yaml";

const path = ".github/workflows/npm-prerelease.yml";
const text = readFileSync(path, "utf8");
const workflow = YAML.parse(text);
const triggers = workflow.on ?? workflow.true;
if (Object.keys(triggers).join(",") !== "workflow_dispatch") throw new Error("legacy tag validator must remain manual-only");
if (!triggers.workflow_dispatch.inputs.dry_run.default) throw new Error("legacy dispatch must default to dry-run");
if (workflow.permissions?.contents !== "read" || workflow.permissions?.["id-token"] !== "none") throw new Error("legacy validator permissions mismatch");
if (workflow.env?.RELEASE_TAG !== "${{ inputs.tag }}") throw new Error("legacy validator must use explicit tag input");
for (const required of [
  'release_sha="$(git rev-parse HEAD^{commit})"',
  'test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$release_sha"',
  'git merge-base --is-ancestor "$release_sha" origin/main',
  'node scripts/verify-npm-prerelease.mjs "$version"',
  "TRUSTED_NPM_VERSION: 11.5.1",
  "node-version: 22.14.0",
  "pnpm test:npm-packages",
]) if (!text.includes(required)) throw new Error(`legacy exact-tag validation missing: ${required}`);
if (/npm publish|npm dist-tag|gh release create|git push|id-token:\s*write|contents:\s*write|NPM_AUTHORIZATION_SHA/.test(text)) throw new Error("legacy validator retained publication or obsolete authorization capability");
console.log("legacy exact-tag validator remains inert");
