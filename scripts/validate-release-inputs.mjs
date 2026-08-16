#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const manifest=JSON.parse(read('docker/release-inputs.json'));
const raw=read('docker/Dockerfile');
const workflow=read('.github/workflows/docker-rebuild.yml');
const lock=read(`docker/${manifest.python.lockFile}`);
const instructions=[];
let current='';
for(const source of raw.split(/\r?\n/)){
 const line=source.replace(/\s+#.*$/,'').trim();
 if(!line || (!current && line.startsWith('#'))) continue;
 current += (current?' ':'')+line.replace(/\\$/,'').trim();
 if(!line.endsWith('\\')) { instructions.push(current.replace(/\s+/g,' ')); current=''; }
}
assert.equal(current,'','unterminated Docker instruction');
const one=(prefix,label)=>{const xs=instructions.filter(x=>x.startsWith(prefix)); assert.equal(xs.length,1,`${label}: expected exactly one semantic instruction`); return xs[0];};
assert.equal(manifest.schemaVersion,1);
const froms=instructions.filter(x=>x.startsWith('FROM ')); assert.equal(froms.length,2);
for(const [name,image] of Object.entries(manifest.baseImages)){assert.match(image.reference,/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/); assert.equal(froms.filter(x=>x.split(/\s+/)[1]===image.reference).length,1,`${name} FROM must consume digest`);}
const apt=one('RUN printf \'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/','apt snapshot configuration'); assert.ok(apt.includes('> /etc/apt/sources.list')); assert.ok(instructions.some(x=>x===`ARG UBUNTU_SNAPSHOT=${manifest.apt.snapshot}`));
const pip=one('RUN pip3 install ','hashed Python install'); assert.ok(pip.includes('--require-hashes --only-binary=:all: -r /opt/release-inputs/requirements.lock')); assert.ok(instructions.includes(`COPY ${manifest.python.lockFile} /opt/release-inputs/requirements.lock`));
for(const block of lock.split(/\n(?=[a-zA-Z0-9])/)){if(!block.trim() || block.trimStart().startsWith('#'))continue; assert.match(block,/^[a-zA-Z0-9_.-]+==[^\s;\\]+/,'every Python dependency must be version pinned'); assert.match(block,/--hash=sha256:[a-f0-9]{64}/,'every Python dependency must be hashed');}
const runs=instructions.filter(x=>x.startsWith('RUN '));
for(const name of ['novnc','sqlcipher']){const s=manifest.sources[name]; assert.match(s.sha256,/^[a-f0-9]{64}$/); const key=name.toUpperCase(); assert.ok(instructions.includes(`ARG ${key}_URL=${s.url}`)); assert.ok(instructions.includes(`ARG ${key}_SHA256=${s.sha256}`)); const run=runs.find(x=>x.includes(`\"$${key}_URL\"`) || x.includes(`"$${key}_URL"`)); assert.ok(run,`${name} download RUN missing`); assert.ok(run.includes(`$${key}_SHA256`) && run.includes('sha256sum --check --strict'),`${name} hash not bound in download RUN`);}
const w=manifest.sources.wechat; const wrun=runs.find(x=>x.includes('dpkg-deb -f /tmp/wechat.deb Package')); assert.ok(wrun,'WeChat install RUN missing');
for(const a of ['amd64','arm64']){const v=w.artifacts[a]; assert.ok(instructions.includes(`ARG WECHAT_${a.toUpperCase()}_URL=${v.url}`)); assert.ok(instructions.includes(`ARG WECHAT_${a.toUpperCase()}_SHA256=${v.sha256}`)); assert.ok(wrun.includes(`${a}) WECHAT_URL=`));}
for(const check of ['sha256sum --check --strict','dpkg-deb -f /tmp/wechat.deb Version','dpkg-deb -f /tmp/wechat.deb Architecture']) assert.ok(wrun.includes(check),`WeChat RUN missing ${check}`);
for(const [copy,presence] of [['cp /opt/novnc/LICENSE.txt','test -s /usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt'],['cp LICENSE.md /usr/share/doc/agent-wechat/licenses/sqlcipher/','test -s /usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md']]){assert.ok(runs.some(x=>x.includes(copy)),`notice copy missing: ${copy}`);assert.ok(wrun.includes(presence),`notice presence missing: ${presence}`);}
for(const p of ['docker/release-inputs.json','docker/release-materials/requirements.lock','scripts/validate-release-inputs.mjs','scripts/test-release-inputs.mjs']) assert.ok(workflow.includes(`- '${p}'`));
console.log('Release inputs are semantically pinned, hash-bound, and notice-checked.');
