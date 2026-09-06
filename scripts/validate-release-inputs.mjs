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
assert.equal(instructionAllowlist.schemaVersion,1);
const keys=(value,expected,label)=>assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),`${label}: authoritative fields drifted`);
keys(instructionAllowlist,['schemaVersion','instructions'],'instruction allowlist');
assert.ok(Array.isArray(instructionAllowlist.instructions)&&instructionAllowlist.instructions.every(x=>typeof x==='string'),'instruction allowlist must contain strings');
assert.deepEqual(instructions,instructionAllowlist.instructions,'effective Docker instruction graph is not exactly allowlisted');
// This policy is deliberately independent of the mutable allowlist. Any instruction
// that can fetch or install content must remain one of these reviewed semantics.
const approvedSensitiveInstructionHashes=new Set([
  'c800a90a1de2560793aa2730949337f9391435273fc686c5fb6c8fc60bffe3bb', // runtime packages
  '857d515e7e5bf29d4828f05f8076962545230bcea4febe9a4856f8fb5641ad7e', // locked Python packages
  '29745539dec974d85e96332400d4d9911ef953f356213ea8150ea6b5b72a29bc', // noVNC
  '9b8d3cee08d655c745e64a8669864c81ba19db346c0d22821c2f5a1901282c02', // SQLCipher
  'a756d19876ff5a30c7f8ae42e037fa77b8c43a2fbccd1b950c1a1a34a854ecd2', // WeChat
  '5a9255760fcbb53017961e56d2e5da80582bee575930f90407bddae7436dd21f', // debug-only gdbserver
]);
const digest=x=>createHash('sha256').update(x).digest('hex');
for(const instruction of instructions){
  assert.ok(!/^ADD\s+https?:\/\//i.test(instruction),'remote ADD is forbidden');
  if(/^RUN\s/.test(instruction)&&/\b(?:curl|wget)\b|\bapt(?:-get)?(?:\s+-o\s+\S+)*\s+(?:update|install)\b|\bpip3?\s+install\b/.test(instruction))assert.ok(approvedSensitiveInstructionHashes.has(digest(instruction)),'unreviewed network or package-install instruction is forbidden');
}
const sqlcipherIndex=instructions.findIndex(x=>x.startsWith('RUN SQLCIPHER_VERSION='));
for(const instruction of instructions.slice(sqlcipherIndex+1))assert.doesNotMatch(instruction,/^(?:ADD|COPY)\b.*(?:sqlcipher|\/opt\/novnc|wechat\.deb)/i,'verified artifact may not be overwritten by a later ADD/COPY');
const one=(prefix,label)=>{const xs=instructions.filter(x=>x.startsWith(prefix));assert.equal(xs.length,1,`${label}: expected exactly one semantic instruction`);return xs[0];};
const exact=(value,label)=>assert.equal(instructions.filter(x=>x===value).length,1,`${label}: exact instruction required`);
assert.equal(manifest.schemaVersion,1);
keys(manifest,['schemaVersion','baseImages','sources','apt','python'],'manifest');
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
assert.equal(runs.filter(x=>/\bapt-get(?:\s+-o\s+\S+)*\s+(?:update|install)\b/.test(x)).length,3,'only approved runtime apt RUNs are allowed');
for(const instruction of runs.filter(x=>/\bapt-get(?:\s+-o\s+\S+)*\s+(?:update|install)\b/.test(x))){
  assert.doesNotMatch(instruction,/\bapt-get\s+(?:update|install)\b/,'apt-get update/install must pass Acquire retries and timeouts');
  assert.match(instruction,/apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 (?:update|install)/,'apt-get must retry snapshot downloads with bounded timeouts');
}
assert.equal(runs.filter(x=>/\bpip3?\s+install\b/.test(x)).length,1,'only locked pip install is allowed');
for(const forbidden of ['archive.ubuntu.com','security.ubuntu.com','deb.debian.org'])assert.ok(!instructions.some(x=>x.includes(forbidden)),`mutable repository forbidden: ${forbidden}`);
for(const name of ['novnc','sqlcipher']){const s=manifest.sources[name],key=name.toUpperCase();assert.equal(s.url,`https://github.com/${name==='novnc'?'novnc/noVNC':'sqlcipher/sqlcipher'}/archive/refs/tags/v${s.version}.tar.gz`,`${name} version must bind its URL`);const run=one(`RUN ${key}_VERSION=`,`${name} source installation`);assert.ok(run.startsWith(`RUN ${key}_VERSION=${s.version} && ${key}_URL=${s.url} && ${key}_SHA256=${s.sha256} && `),`${name}: immutable source constants must exactly match manifest`);assert.ok(run.includes(`curl --fail --location --retry 3`)&&run.includes(`"$${key}_URL"`));assert.ok(run.includes(`echo "$${key}_SHA256 `)&&run.includes('| sha256sum --check --strict &&'),`${name} verification must gate extraction`);}
const w=manifest.sources.wechat;assert.equal(w.version,'4.1.1.8');const wrun=one('RUN WECHAT_VERSION=','WeChat source installation');
const wechatUrls={amd64:'https://web.archive.org/web/20260818044438id_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb',arm64:'https://web.archive.org/web/20260818044442id_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb'};
const wechatPins={amd64:'c9765e87ee5133bf4bb50d585c1814fafd995e3fb0da62c5ed07259b43dada7b',arm64:'c3ed1a481247e6a1b166e87a66cccdee898c3ae0b76613b39bb6e9795e50929f'};
const liveWeChatDeb=/^https:\/\/dldir1v6\.qq\.com\/weixin\/Universal\/Linux\/WeChatLinux_(?:x86_64|arm64)\.deb$/;
for(const a of ['amd64','arm64']){const v=w.artifacts[a];assert.equal(v.packageArchitecture,a);assert.equal(v.url,wechatUrls[a]);assert.equal(v.sha256,wechatPins[a]);assert.match(v.url,/web\.archive\.org\/web\/20260818/);assert.ok(v.url.includes('id_'));assert.ok(!liveWeChatDeb.test(v.url),`${a}: live Tencent CDN must not be the build URL`);assert.ok(wrun.includes(`WECHAT_${a.toUpperCase()}_URL=${v.url} && WECHAT_${a.toUpperCase()}_SHA256=${v.sha256} && `),`${a}: immutable WeChat constants must exactly match manifest`);assert.ok(wrun.includes(`${a}) WECHAT_URL=`));}
assert.doesNotMatch(wrun,/(?:WECHAT_(?:AMD64|ARM64)_URL|WECHAT_URL)=https:\/\/dldir1v6\.qq\.com\/weixin\/Universal\/Linux\/WeChatLinux_/);
const downloadWeChat=read('scripts/download-wechat.sh');
assert.ok(downloadWeChat.includes(wechatUrls.amd64)&&downloadWeChat.includes(wechatUrls.arm64));
assert.ok(downloadWeChat.includes(wechatPins.amd64)&&downloadWeChat.includes(wechatPins.arm64));
assert.doesNotMatch(downloadWeChat,/^URL="https:\/\/dldir1v6\.qq\.com\/weixin\/Universal\/Linux\/WeChatLinux_/m);
assert.ok(wrun.startsWith(`RUN WECHAT_VERSION=${w.version} && `),'immutable WeChat version must exactly match manifest');
for(const check of ['echo "$WECHAT_SHA256 /tmp/wechat.deb" | sha256sum --check --strict && test "$(dpkg-deb -f /tmp/wechat.deb Package)" = wechat','test "$(dpkg-deb -f /tmp/wechat.deb Version)" = "$WECHAT_VERSION"','test "$(dpkg-deb -f /tmp/wechat.deb Architecture)" = "$DEB_ARCH"'])assert.ok(wrun.includes(check),`WeChat semantic check missing: ${check}`);
for(const p of ['docker/release-inputs.json','docker/release-instruction-allowlist.json','docker/release-materials/requirements.lock','docker/release-materials/frida_tools-14.10.4-py3-none-any.whl','scripts/validate-release-inputs.mjs','scripts/test-release-inputs.mjs','scripts/download-wechat.sh'])assert.ok(workflow.includes(`- '${p}'`),`workflow path missing: ${p}`);
console.log('Release inputs are semantically pinned, hash-bound, and allowlisted.');
