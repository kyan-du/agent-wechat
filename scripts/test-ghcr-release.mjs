#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const run=dir=>spawnSync(process.execPath,['scripts/validate-ghcr-release.mjs'],{cwd:dir,encoding:'utf8'});
assert.equal(run(root).status,0);
const mutations=[
 ['contents: read','contents: write'],
 ['packages: write','packages: read'],
 ['test "$GITHUB_REF" = refs/heads/main','test -n "$GITHUB_REF"'],
 ['test "$GITHUB_SHA" = "$(git rev-parse origin/main)"','test -n "$GITHUB_SHA"'],
 ['push-by-digest=true,name-canonical=true,push=true','push=true,tags=ghcr.io/kyan-du/agent-wechat:next'],
 ['ubuntu-24.04-arm','ubuntu-latest'],
 ['linux/arm64','linux/amd64'],
 ['--tag "$IMAGE:$VERSION"','--tag "$IMAGE:latest"'],
 ['cancel-in-progress: false','cancel-in-progress: true'],
];
for(const [from,to] of mutations){const d=mkdtempSync(join(tmpdir(),'ghcr-policy-'));try{cpSync(join(root,'.github'),join(d,'.github'),{recursive:true});cpSync(join(root,'scripts'),join(d,'scripts'),{recursive:true});const p=join(d,'.github/workflows/ghcr-prerelease.yml'),s=readFileSync(p,'utf8');assert.ok(s.includes(from));writeFileSync(p,s.replace(from,to));assert.notEqual(run(d).status,0,`${from} mutation escaped`);}finally{rmSync(d,{recursive:true,force:true});}}
console.log(`${mutations.length} GHCR workflow mutations failed closed.`);
