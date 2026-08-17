#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const path = '.github/workflows/npm-prerelease.yml';
const text = readFileSync(path, 'utf8');
const workflow = YAML.parse(text);
const triggers = workflow.on ?? workflow.true;
if (!triggers?.push?.tags?.includes('v[0-9]+.[0-9]+.[0-9]+-next.[0-9]+')) throw new Error('exact next tag trigger missing');
if (!triggers?.workflow_dispatch?.inputs?.dry_run?.default) throw new Error('manual dispatch must default to dry-run');
if (workflow.permissions?.contents !== 'write' || workflow.permissions?.['id-token'] !== 'write') throw new Error('release permissions mismatch');
if (!text.includes('node scripts/verify-npm-prerelease.mjs "$version"')) throw new Error('tag/package version guard missing');
if (!text.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')) throw new Error('main ancestry guard missing');
if (!text.includes("if: ${{ github.event_name == 'push' }}")) throw new Error('publish side effects are not push-tag gated');
for (const required of ['pnpm typecheck', 'pnpm build', 'pnpm test:npm-packages', '--tag next', '--provenance', 'gh release create']) {
  if (!text.includes(required)) throw new Error(`workflow requirement missing: ${required}`);
}
if (/--tag\s+latest|npm\s+dist-tag\s+add[^\n]+latest/.test(text)) throw new Error('latest publication is forbidden');
console.log('tag release workflow contract passed');
