#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
function run(dir){ return spawnSync(process.execPath,['scripts/validate-release-inputs.mjs'],{cwd:dir,encoding:'utf8'}); }
assert.equal(run(root).status,0);
for (const mutate of [
  d=>{ const p=join(d,'docker/release-inputs.json'); const x=JSON.parse(readFileSync(p)); x.sources.novnc.sha256='0'.repeat(64); writeFileSync(p,JSON.stringify(x,null,2)); },
  d=>{ const p=join(d,'docker/Dockerfile'); writeFileSync(p,readFileSync(p,'utf8').split('sha256sum --check --strict').join('sha256sum')); },
  d=>{ const p=join(d,'docker/Dockerfile'); writeFileSync(p,readFileSync(p,'utf8').split('/usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md').join('/missing-sqlcipher-notice')); },
]) { const d=mkdtempSync(join(tmpdir(),'release-inputs-')); for(const x of ['docker','.github','scripts']) cpSync(join(root,x),join(d,x),{recursive:true}); mutate(d); assert.notEqual(run(d).status,0,'drift mutation must fail closed'); rmSync(d,{recursive:true,force:true}); }
console.log('Release input drift negative tests passed.');
