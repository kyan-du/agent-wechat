#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const path = '.github/workflows/npm-prerelease.yml';
const text = readFileSync(path, 'utf8');
const workflow = YAML.parse(text);
const triggers = workflow.on ?? workflow.true;
if (triggers?.push) throw new Error('tag publication must remain inert until independent authorization');
if (!triggers?.workflow_dispatch?.inputs?.dry_run?.default) throw new Error('manual dispatch must default to dry-run');
if (workflow.permissions?.contents !== 'read' || workflow.permissions?.['id-token'] !== 'none') throw new Error('inert workflow permissions mismatch');
if (!text.includes("github.event_name == 'push' && github.ref_name || inputs.tag")) throw new Error('future event-specific tag selection missing');
if (!text.includes('node scripts/verify-npm-release-authorization.mjs "$RELEASE_TAG" "$GITHUB_SHA"')) throw new Error('independent release authorization missing');
if (!text.includes('TRUSTED_NPM_VERSION: 11.5.1') || !text.includes('node-version: 22.14.0') || !text.includes('npm install --global "npm@$TRUSTED_NPM_VERSION"')) throw new Error('Trusted Publishing npm consumer is not pinned');
if (!text.includes('node scripts/verify-npm-versions-absent.mjs "${RELEASE_TAG#v}"')) throw new Error('fail-closed registry preflight missing');
if (!text.includes('node scripts/verify-npm-prerelease.mjs "$version"')) throw new Error('tag/package version guard missing');
if (!text.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')) throw new Error('main ancestry guard missing');
if (!text.includes("if: ${{ github.event_name == 'push' }}")) throw new Error('publish side effects are not push-tag gated');
for (const required of ['pnpm typecheck', 'pnpm build', 'pnpm test:npm-packages', '--tag next', '--provenance', 'gh release create']) {
  if (!text.includes(required)) throw new Error(`workflow requirement missing: ${required}`);
}
if (/--tag\s+latest|npm\s+dist-tag\s+add[^\n]+latest/.test(text)) throw new Error('latest publication is forbidden');
const releaseTag = workflow.env?.RELEASE_TAG;
if (releaseTag !== "${{ github.event_name == 'push' && github.ref_name || inputs.tag }}") throw new Error('parsed release tag expression mismatch');
console.log('tag release workflow contract passed');
