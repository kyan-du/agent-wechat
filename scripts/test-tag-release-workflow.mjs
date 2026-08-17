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
if (!text.includes('release_sha="$(git rev-parse HEAD^{commit})"')) throw new Error('checked-out release SHA resolution missing');
if (!text.includes('test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$release_sha"')) throw new Error('peeled tag/head equality missing');
if (!text.includes('authorization_ref="refs/tags/npm-release-auth/$RELEASE_TAG"')) throw new Error('protected authorization ref missing');
if (!text.includes('"$RELEASE_TAG" "$RELEASE_SHA" "$authorization_ref"')) throw new Error('independent release authorization missing');
if (!text.includes('"$NPM_AUTHORIZATION_SHA" "$NPM_AUTHORIZATION_TAG_OID"')) throw new Error('authorization commit/tag object binding missing');
if (!text.includes('node scripts/test-npm-release-authorization.mjs')) throw new Error('authorization Git E2E matrix missing from validation');
if (!text.includes('TRUSTED_NPM_VERSION: 11.5.1') || !text.includes('node-version: 22.14.0') || !text.includes('npm install --global "npm@$TRUSTED_NPM_VERSION"')) throw new Error('Trusted Publishing npm consumer is not pinned');
if (!text.includes('node scripts/verify-npm-versions-absent.mjs "${RELEASE_TAG#v}"')) throw new Error('fail-closed registry preflight missing');
if (!text.includes('node scripts/verify-npm-prerelease.mjs "$version"')) throw new Error('tag/package version guard missing');
if (!text.includes('git merge-base --is-ancestor "$release_sha" origin/main')) throw new Error('resolved main ancestry guard missing');
if (!text.includes("if: ${{ github.event_name == 'push' }}")) throw new Error('publish side effects are not push-tag gated');
for (const required of ['pnpm typecheck', 'pnpm build', 'pnpm test:npm-packages', '--tag next', '--provenance', 'gh release create']) {
  if (!text.includes(required)) throw new Error(`workflow requirement missing: ${required}`);
}
if (/--tag\s+latest|npm\s+dist-tag\s+add[^\n]+latest/.test(text)) throw new Error('latest publication is forbidden');
const releaseTag = workflow.env?.RELEASE_TAG;
if (releaseTag !== "${{ github.event_name == 'push' && github.ref_name || inputs.tag }}") throw new Error('parsed release tag expression mismatch');
const resolveTag = (event, refName, inputTag) => event === 'push' ? refName : inputTag;
if (resolveTag('workflow_dispatch', 'main', 'v1.2.3-next.4') !== 'v1.2.3-next.4') throw new Error('dispatch event context ignores input tag');
if (resolveTag('push', 'v1.2.3-next.4', undefined) !== 'v1.2.3-next.4') throw new Error('push event context ignores tag ref');
console.log('tag release workflow contract passed');
