#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const text = readFileSync(new URL('.github/workflows/ghcr-prerelease.yml', root), 'utf8');
const workflow = parse(text);
const trigger = workflow.on ?? workflow.true;
assert.deepEqual(Object.keys(trigger), ['workflow_dispatch'], 'GHCR publication must be manual-only');
assert.deepEqual(workflow.permissions, { contents: 'read', packages: 'write' });
assert.equal(workflow.concurrency['cancel-in-progress'], false);
assert.match(workflow.concurrency.group, /inputs\.version/);
assert.equal(workflow.env.IMAGE, 'ghcr.io/kyan-du/agent-wechat');
assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(x => [x.runner, x.arch, x.platform]), [
  ['ubuntu-latest', 'amd64', 'linux/amd64'],
  ['ubuntu-24.04-arm', 'arm64', 'linux/arm64'],
]);
assert.match(text, /test "\$GITHUB_REF" = refs\/heads\/main/);
assert.match(text, /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/);
assert.match(text, /push-by-digest=true,name-canonical=true,push=true/);
assert.match(text, /imagetools create --tag "\$IMAGE:\$VERSION"/);
assert.doesNotMatch(text, /(?:^|[:\s])(latest|next)(?:$|[:\s])/m, 'floating image tags are forbidden');
assert.equal((text.match(/--tag /g) ?? []).length, 1, 'only the merge job may create a tag');
assert.equal((text.match(/packages: write/g) ?? []).length, 1);
assert.match(text, /type=gha,scope=ghcr-\$\{\{ matrix\.arch \}\}/);

const runtime = process.argv[2] === '--runtime';
if (runtime) {
  const version = process.argv[3];
  const sha = process.argv[4];
  assert.match(version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-next\.(?:0|[1-9]\d*)$/, 'version must be an exact next semver prerelease');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  const main = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
  assert.equal(sha, main, 'release SHA must equal origin/main');
  const contract = JSON.parse(readFileSync(new URL('release/prerelease-contract.json', root)));
  assert.equal(contract.imageRepository, workflow.env.IMAGE);
  assert.equal(contract.versionPrerelease, 'next');
  assert.equal(contract.externalSideEffects, true, 'release contract must explicitly authorize publication');
}
console.log(runtime ? 'GHCR runtime authorization passed' : 'GHCR workflow policy passed');
