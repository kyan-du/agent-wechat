#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const run=dir=>spawnSync(process.execPath,['scripts/validate-release-inputs.mjs'],{cwd:dir,encoding:'utf8'});
assert.equal(run(root).status,0);
const replace=(d,path,from,to)=>{const p=join(d,path),s=readFileSync(p,'utf8');assert.ok(s.includes(from),`fixture missing ${from}`);writeFileSync(p,s.replace(from,to));};
const mutations=[
 d=>replace(d,'docker/Dockerfile','FROM rust:1.93-bookworm@sha256:','FROM rust:1.93-bookworm # pinned reference was sha256:'),
 d=>replace(d,'docker/Dockerfile','"$NOVNC_SHA256  /tmp/novnc.tar.gz" | sha256sum --check --strict','"unchecked noVNC"'),
 d=>replace(d,'docker/Dockerfile','"$SQLCIPHER_SHA256  sqlcipher.tar.gz" | sha256sum --check --strict','"unchecked SQLCipher"'),
 d=>replace(d,'docker/Dockerfile','"$WECHAT_SHA256  /tmp/wechat.deb" | sha256sum --check --strict','"unchecked WeChat"'),
 d=>replace(d,'docker/Dockerfile','dpkg-deb -f /tmp/wechat.deb Version','echo ignored-version'),
 d=>replace(d,'docker/Dockerfile','dpkg-deb -f /tmp/wechat.deb Architecture','echo ignored-architecture'),
 d=>replace(d,'docker/Dockerfile','cp /opt/novnc/LICENSE.txt','echo /opt/novnc/LICENSE.txt'),
 d=>replace(d,'docker/Dockerfile','cp LICENSE.md /usr/share/doc/agent-wechat/licenses/sqlcipher/','echo LICENSE.md /usr/share/doc/agent-wechat/licenses/sqlcipher/'),
 d=>replace(d,'docker/Dockerfile','test -s /usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt','echo /usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt'),
 d=>replace(d,'docker/Dockerfile','test -s /usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md','echo /usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md'),
 d=>replace(d,'docker/Dockerfile','pip3 install --require-hashes','pip3 install'),
 d=>replace(d,'docker/release-materials/requirements.lock','frida-tools==14.10.4','frida-tools'),
 d=>replace(d,'docker/release-materials/requirements.lock','--hash=sha256:7a2c544b545d095040fffbd3768a287a426343dad89095b4a24f4b20382d926a','--trusted-host=pypi.org'),
 d=>replace(d,'docker/Dockerfile','https://snapshot.ubuntu.com/ubuntu/%s jammy main','http://archive.ubuntu.com/ubuntu jammy main'),
];
for(const mutate of mutations){const d=mkdtempSync(join(tmpdir(),'release-inputs-'));try{for(const x of ['docker','.github','scripts'])cpSync(join(root,x),join(d,x),{recursive:true});mutate(d);const result=run(d);assert.notEqual(result.status,0,`mutation escaped validator: ${result.stdout}`);}finally{rmSync(d,{recursive:true,force:true});}}
console.log(`${mutations.length} semantic release-input mutations failed closed.`);
