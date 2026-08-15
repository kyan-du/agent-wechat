#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../docker/release-inputs.json', import.meta.url)));
const dockerfile = readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/docker-rebuild.yml', import.meta.url), 'utf8');
const hex = /^[a-f0-9]{64}$/;

assert.equal(manifest.schemaVersion, 1);
for (const [name, image] of Object.entries(manifest.baseImages)) {
  assert.match(image.reference, /^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/, `${name} must use an immutable digest`);
  assert.ok(dockerfile.includes(`FROM ${image.reference}`), `${name} manifest reference must match Dockerfile`);
}
for (const name of ['novnc', 'sqlcipher']) {
  const source = manifest.sources[name];
  assert.match(source.sha256, hex, `${name} must have SHA-256`);
  assert.ok(dockerfile.includes(source.url), `${name} URL must match Dockerfile`);
  assert.ok(dockerfile.includes(source.sha256), `${name} SHA-256 must match Dockerfile`);
}
const wechat = manifest.sources.wechat;
assert.match(wechat.version, /^\d+(?:\.\d+)+$/);
assert.ok(dockerfile.includes(`ARG WECHAT_VERSION=${wechat.version}`));
for (const arch of ['amd64', 'arm64']) {
  const artifact = wechat.artifacts[arch];
  assert.equal(artifact.packageArchitecture, arch);
  assert.match(artifact.sha256, hex, `wechat ${arch} must have SHA-256`);
  assert.ok(dockerfile.includes(artifact.url), `wechat ${arch} URL must match Dockerfile`);
  assert.ok(dockerfile.includes(artifact.sha256), `wechat ${arch} SHA-256 must match Dockerfile`);
}
for (const required of [
  'sha256sum --check --strict',
  'dpkg-deb -f /tmp/wechat.deb Version',
  '/usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt',
  '/usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md',
]) assert.ok(dockerfile.includes(required), `Dockerfile missing fail-closed check: ${required}`);
for (const path of ['docker/release-inputs.json', 'scripts/validate-release-inputs.mjs', 'scripts/test-release-inputs.mjs']) {
  assert.ok(workflow.includes(`- '${path}'`), `Docker validation paths must include ${path}`);
}
console.log('Release input manifest, Dockerfile pins, notices, and CI paths are consistent.');
