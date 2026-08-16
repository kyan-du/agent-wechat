#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
// JSON.parse silently accepts duplicate keys (last value wins). Release policy files
// are authority inputs, so reject duplicates before parsing them.
const parseStrictJson=(text,label)=>{
  let i=0; const fail=message=>{throw new Error(`${label}: ${message} at byte ${i}`);};
  const ws=()=>{while(/\s/.test(text[i]??''))i++;};
  const string=()=>{const start=i;if(text[i++]!=='"')fail('expected string');for(;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"'){i++;try{return JSON.parse(text.slice(start,i));}catch{fail('invalid string');}}}fail('unterminated string');};
  const value=()=>{ws();if(text[i]==='{')return object();if(text[i]==='[')return array();if(text[i]==='"')return string();const m=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!m)fail('invalid value');i+=m[0].length;return JSON.parse(m[0]);};
  const object=()=>{const out={},seen=new Set();i++;ws();if(text[i]==='}'){i++;return out;}for(;;){ws();const key=string();if(seen.has(key))fail(`duplicate key ${JSON.stringify(key)}`);seen.add(key);ws();if(text[i++]!==':')fail('expected colon');out[key]=value();ws();const c=text[i++];if(c==='}')return out;if(c!==',')fail('expected comma or closing brace');}};
  const array=()=>{const out=[];i++;ws();if(text[i]===']'){i++;return out;}for(;;){out.push(value());ws();const c=text[i++];if(c===']')return out;if(c!==',')fail('expected comma or closing bracket');}};
  const result=value();ws();if(i!==text.length)fail('trailing content');return result;
};
const manifest=parseStrictJson(read('docker/release-inputs.json'),'release-inputs.json');
const instructionAllowlist=parseStrictJson(read('docker/release-instruction-allowlist.json'),'release-instruction-allowlist.json');
const raw=read('docker/Dockerfile');
const workflow=read('.github/workflows/docker-rebuild.yml');
const lock=read(`docker/${manifest.python.lockFile}`);
const instructions=[]; let current='';
for(const line of raw.split(/\r?\n/))assert.doesNotMatch(line,/^\s*#\s*(?:syntax|escape|check)\s*=/i,'Docker parser directives are forbidden');
for(const source of raw.split(/\r?\n/)){const line=source.replace(/\s+#.*$/,'').trim();if(!line||(!current&&line.startsWith('#')))continue;current+=(current?' ':'')+line.replace(/\\$/,'').trim();if(!line.endsWith('\\')){instructions.push(current.replace(/\s+/g,' '));current='';}}
assert.equal(current,'','unterminated Docker instruction');
const keys=(value,expected,label)=>assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),`${label}: authoritative fields drifted`);
assert.equal(instructionAllowlist.schemaVersion,1);
keys(instructionAllowlist,['schemaVersion','instructions'],'derived instruction listing');
assert.ok(Array.isArray(instructionAllowlist.instructions)&&instructionAllowlist.instructions.every(x=>typeof x==='string'));
assert.deepEqual(instructions,instructionAllowlist.instructions,'derived instruction listing is stale');
// This listing is diagnostic/derived only and is not authority; the independent code hash below governs.
// Independent closed positive policy: these digests are code-reviewed authority,
// not editable data adjacent to the Dockerfile. The graph digest covers every
// normalized instruction, in order, across every stage. Any added, removed, moved,
// case-changed, shell/JSON-form, ONBUILD, SHELL, ADD/COPY, or RUN instruction changes
// the digest and is rejected, regardless of changes to other Docker-side files.
const digest=x=>createHash('sha256').update(x).digest('hex');
const CANONICAL_GRAPH_SHA256='6d4f8d9181f3c25455647d0c4dd3a2f8505edf4f1aa94dece19ff9914eee8c57';
const CANONICAL_MANIFEST_SHA256='667a73d67092dff459b7846fd06d4441c815d7a974dd27c56f0fa32342d1a439';
assert.equal(digest(JSON.stringify(instructions)),CANONICAL_GRAPH_SHA256,'complete effective Docker build graph is not the independently approved graph');
assert.equal(digest(JSON.stringify(manifest)),CANONICAL_MANIFEST_SHA256,'release manifest is not the independently approved canonical policy');
const one=(prefix,label)=>{const xs=instructions.filter(x=>x.startsWith(prefix));assert.equal(xs.length,1,`${label}: expected exactly one semantic instruction`);return xs[0];};
const exact=(value,label)=>assert.equal(instructions.filter(x=>x===value).length,1,`${label}: exact instruction required`);
assert.equal(manifest.schemaVersion,1);
keys(manifest,['schemaVersion','baseImages','sources','noticeDirectory','apt','python'],'manifest');
keys(manifest.baseImages,['builder','runtime'],'base images');
keys(manifest.baseImages.builder,['reference','providedPackages','providedFiles'],'builder image');
keys(manifest.baseImages.runtime,['reference'],'runtime image');
keys(manifest.baseImages.builder.providedPackages,['pkg-config'],'builder provided packages');
assert.deepEqual(manifest.baseImages.builder.providedFiles,['/etc/ssl/certs/ca-certificates.crt'],'builder provided files');
keys(manifest.sources,['novnc','sqlcipher','wechat'],'sources');
for(const name of ['novnc','sqlcipher'])keys(manifest.sources[name],['version','url','sha256'],`${name} source`);
keys(manifest.sources.wechat,['version','artifacts'],'WeChat source');
keys(manifest.sources.wechat.artifacts,['amd64','arm64'],'WeChat artifacts');
for(const arch of ['amd64','arm64'])keys(manifest.sources.wechat.artifacts[arch],['packageArchitecture','url','sha256'],`WeChat ${arch} artifact`);
keys(manifest.apt,['snapshot','url'],'apt authority');
keys(manifest.python,['lockFile','installerFlags','localArtifacts'],'Python authority');
keys(manifest.python.localArtifacts,['frida-tools'],'Python local artifacts');
keys(manifest.python.localArtifacts['frida-tools'],['file','sha256'],'frida-tools artifact');
assert.deepEqual(manifest.python.installerFlags,['--require-hashes','--only-binary=:all:','--find-links=/opt/release-inputs'],'Python installer flags');
assert.equal(manifest.noticeDirectory,'/usr/share/doc/agent-wechat/licenses');
assert.equal(manifest.apt.url,'https://snapshot.ubuntu.com/ubuntu');
const froms=instructions.filter(x=>x.startsWith('FROM '));assert.equal(froms.length,2);
for(const image of Object.values(manifest.baseImages))assert.match(image.reference,/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/);
assert.equal(froms[0],`FROM ${manifest.baseImages.builder.reference} AS builder`,'builder digest must be bound to the builder stage role');
assert.equal(froms[1],`FROM ${manifest.baseImages.runtime.reference}`,'runtime digest must be bound to the final stage role');
exact(`RUN command -v pkg-config && test "$(dpkg-query -W -f='\${Version}' pkg-config)" = "${manifest.baseImages.builder.providedPackages['pkg-config']}"`,'builder package assertion');
exact('COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt','pinned CA bootstrap');
const releaseInputNames=['UBUNTU_SNAPSHOT','NOVNC_VERSION','NOVNC_URL','NOVNC_SHA256','SQLCIPHER_VERSION','SQLCIPHER_URL','SQLCIPHER_SHA256','WECHAT_VERSION','WECHAT_AMD64_URL','WECHAT_AMD64_SHA256','WECHAT_ARM64_URL','WECHAT_ARM64_SHA256'];
for(const name of releaseInputNames)assert.ok(!instructions.some(x=>x===`ARG ${name}`||x.startsWith(`ARG ${name}=`)),`${name}: release input must not be caller-overridable`);
const apt=one('RUN UBUNTU_SNAPSHOT=','apt snapshot configuration');
assert.equal(apt,`RUN UBUNTU_SNAPSHOT=${manifest.apt.snapshot} && printf 'deb [check-valid-until=no] ${manifest.apt.url}/%s jammy main restricted universe multiverse\\ndeb [check-valid-until=no] ${manifest.apt.url}/%s jammy-updates main restricted universe multiverse\\ndeb [check-valid-until=no] ${manifest.apt.url}/%s jammy-security main restricted universe multiverse\\n' "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" > /etc/apt/sources.list`);
const local=manifest.python.localArtifacts['frida-tools'];const bytes=readFileSync(new URL(`../docker/${local.file}`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),local.sha256,'local wheel hash drift');
exact(`COPY ${manifest.python.lockFile} ${local.file} /opt/release-inputs/`,'locked Python inputs copy');
exact('RUN pip3 install --require-hashes --only-binary=:all: --find-links=/opt/release-inputs -r /opt/release-inputs/requirements.lock','hashed Python install');
for(const block of lock.split(/\n(?=[a-zA-Z0-9])/)){if(!block.trim()||block.trimStart().startsWith('#'))continue;assert.match(block,/^[a-zA-Z0-9_.-]+==[^\s;\\]+/);assert.match(block,/--hash=sha256:[a-f0-9]{64}/);}
assert.ok(lock.includes(`frida-tools==14.10.4 \\\n    --hash=sha256:${local.sha256}`));
const runs=instructions.filter(x=>x.startsWith('RUN '));
assert.equal(runs.filter(x=>/\bapt-get\s+(update|install)\b/.test(x)).length,3,'only approved runtime apt RUNs are allowed');
assert.equal(runs.filter(x=>/\bpip3?\s+install\b/.test(x)).length,1,'only locked pip install is allowed');
for(const forbidden of ['archive.ubuntu.com','security.ubuntu.com','deb.debian.org'])assert.ok(!instructions.some(x=>x.includes(forbidden)),`mutable repository forbidden: ${forbidden}`);
for(const name of ['novnc','sqlcipher']){const s=manifest.sources[name],key=name.toUpperCase();assert.equal(s.url,`https://github.com/${name==='novnc'?'novnc/noVNC':'sqlcipher/sqlcipher'}/archive/refs/tags/v${s.version}.tar.gz`,`${name} version must bind its URL`);const run=one(`RUN ${key}_VERSION=`,`${name} source installation`);assert.ok(run.startsWith(`RUN ${key}_VERSION=${s.version} && ${key}_URL=${s.url} && ${key}_SHA256=${s.sha256} && `),`${name}: immutable source constants must exactly match manifest`);assert.ok(run.includes(`curl --fail --location --retry 3`)&&run.includes(`"$${key}_URL"`));assert.ok(run.includes(`echo "$${key}_SHA256 `)&&run.includes('| sha256sum --check --strict &&'),`${name} verification must gate extraction`);}
const w=manifest.sources.wechat;assert.match(w.version,/^\d+\.\d+\.\d+\.\d+$/);const wrun=one('RUN WECHAT_VERSION=','WeChat source installation');
for(const a of ['amd64','arm64']){const v=w.artifacts[a];assert.equal(v.packageArchitecture,a);assert.equal(v.url,`https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_${a==='amd64'?'x86_64':'arm64'}.deb`);assert.ok(wrun.includes(`WECHAT_${a.toUpperCase()}_URL=${v.url} && WECHAT_${a.toUpperCase()}_SHA256=${v.sha256} && `),`${a}: immutable WeChat constants must exactly match manifest`);assert.ok(wrun.includes(`${a}) WECHAT_URL=`));}
assert.ok(wrun.startsWith(`RUN WECHAT_VERSION=${w.version} && `),'immutable WeChat version must exactly match manifest');
for(const check of ['echo "$WECHAT_SHA256 /tmp/wechat.deb" | sha256sum --check --strict && test "$(dpkg-deb -f /tmp/wechat.deb Package)" = wechat','test "$(dpkg-deb -f /tmp/wechat.deb Version)" = "$WECHAT_VERSION"','test "$(dpkg-deb -f /tmp/wechat.deb Architecture)" = "$DEB_ARCH"'])assert.ok(wrun.includes(check),`WeChat semantic check missing: ${check}`);
for(const [copy,presence] of [['&& cp /opt/novnc/LICENSE.txt /opt/novnc/docs/LICENSE.* /usr/share/doc/agent-wechat/licenses/novnc/ &&','test -s /usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt'],['&& cp LICENSE.md /usr/share/doc/agent-wechat/licenses/sqlcipher/ &&','test -s /usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md']]){assert.ok(runs.some(x=>x.includes(copy)),`notice copy missing: ${copy}`);assert.ok(wrun.includes(presence));}
for(const p of ['docker/release-inputs.json','docker/release-materials/requirements.lock','docker/release-materials/frida_tools-14.10.4-py3-none-any.whl','scripts/validate-release-inputs.mjs','scripts/test-release-inputs.mjs','scripts/download-wechat.sh'])assert.ok(workflow.includes(`- '${p}'`),`workflow path missing: ${p}`);
console.log('Release inputs match the independent closed positive build graph and canonical manifest.');
