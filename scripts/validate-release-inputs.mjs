#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const manifest=JSON.parse(read('docker/release-inputs.json'));
const instructionAllowlist=JSON.parse(read('docker/release-instruction-allowlist.json'));
const raw=read('docker/Dockerfile');
const workflow=read('.github/workflows/docker-rebuild.yml');
const lock=read(`docker/${manifest.python.lockFile}`);
const instructions=[]; let current='';
for(const source of raw.split(/\r?\n/)){const line=source.replace(/\s+#.*$/,'').trim();if(!line||(!current&&line.startsWith('#')))continue;current+=(current?' ':'')+line.replace(/\\$/,'').trim();if(!line.endsWith('\\')){instructions.push(current.replace(/\s+/g,' '));current='';}}
assert.equal(current,'','unterminated Docker instruction');
assert.equal(instructionAllowlist.schemaVersion,1);
assert.deepEqual(instructions,instructionAllowlist.instructions,'effective Docker instruction graph is not exactly allowlisted');
const one=(prefix,label)=>{const xs=instructions.filter(x=>x.startsWith(prefix));assert.equal(xs.length,1,`${label}: expected exactly one semantic instruction`);return xs[0];};
const exact=(value,label)=>assert.equal(instructions.filter(x=>x===value).length,1,`${label}: exact instruction required`);
assert.equal(manifest.schemaVersion,1);
const keys=(value,expected,label)=>assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),`${label}: authoritative fields drifted`);
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
for(const [name,image] of Object.entries(manifest.baseImages)){assert.match(image.reference,/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/);assert.equal(froms.filter(x=>x.split(/\s+/)[1]===image.reference).length,1,`${name} FROM must consume digest`);}
exact(`RUN command -v pkg-config && test "$(dpkg-query -W -f='\${Version}' pkg-config)" = "${manifest.baseImages.builder.providedPackages['pkg-config']}"`,'builder package assertion');
exact('COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt','pinned CA bootstrap');
exact(`ARG UBUNTU_SNAPSHOT=${manifest.apt.snapshot}`,'snapshot argument');
const apt=one("RUN printf 'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/",'apt snapshot configuration');
assert.equal(apt,`RUN printf 'deb [check-valid-until=no] ${manifest.apt.url}/%s jammy main restricted universe multiverse\\ndeb [check-valid-until=no] ${manifest.apt.url}/%s jammy-updates main restricted universe multiverse\\ndeb [check-valid-until=no] ${manifest.apt.url}/%s jammy-security main restricted universe multiverse\\n' "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" > /etc/apt/sources.list`);
const local=manifest.python.localArtifacts['frida-tools'];const bytes=readFileSync(new URL(`../docker/${local.file}`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),local.sha256,'local wheel hash drift');
exact(`COPY ${manifest.python.lockFile} ${local.file} /opt/release-inputs/`,'locked Python inputs copy');
exact('RUN pip3 install --require-hashes --only-binary=:all: --find-links=/opt/release-inputs -r /opt/release-inputs/requirements.lock','hashed Python install');
for(const block of lock.split(/\n(?=[a-zA-Z0-9])/)){if(!block.trim()||block.trimStart().startsWith('#'))continue;assert.match(block,/^[a-zA-Z0-9_.-]+==[^\s;\\]+/);assert.match(block,/--hash=sha256:[a-f0-9]{64}/);}
assert.ok(lock.includes(`frida-tools==14.10.4 \\\n    --hash=sha256:${local.sha256}`));
const runs=instructions.filter(x=>x.startsWith('RUN '));
assert.equal(runs.filter(x=>/\bapt-get\s+(update|install)\b/.test(x)).length,3,'only approved runtime apt RUNs are allowed');
assert.equal(runs.filter(x=>/\bpip3?\s+install\b/.test(x)).length,1,'only locked pip install is allowed');
for(const forbidden of ['archive.ubuntu.com','security.ubuntu.com','deb.debian.org'])assert.ok(!instructions.some(x=>x.includes(forbidden)),`mutable repository forbidden: ${forbidden}`);
for(const name of ['novnc','sqlcipher']){const s=manifest.sources[name],key=name.toUpperCase();assert.equal(s.url,`https://github.com/${name==='novnc'?'novnc/noVNC':'sqlcipher/sqlcipher'}/archive/refs/tags/v${s.version}.tar.gz`,`${name} version must bind its URL`);exact(`ARG ${key}_URL=${s.url}`,`${name} URL`);exact(`ARG ${key}_SHA256=${s.sha256}`,`${name} hash`);const run=runs.find(x=>x.includes(`curl --fail --location --retry 3`)&&x.includes(`"$${key}_URL"`));assert.ok(run);assert.ok(run.includes(`echo "$${key}_SHA256 `)&&run.includes('| sha256sum --check --strict &&'),`${name} verification must gate extraction`);}
const w=manifest.sources.wechat;assert.match(w.version,/^\d+\.\d+\.\d+\.\d+$/);exact(`ARG WECHAT_VERSION=${w.version}`,'WeChat version');const wrun=runs.find(x=>x.includes('dpkg-deb -f /tmp/wechat.deb Package'));assert.ok(wrun);
for(const a of ['amd64','arm64']){const v=w.artifacts[a];assert.equal(v.packageArchitecture,a);assert.equal(v.url,`https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_${a==='amd64'?'x86_64':'arm64'}.deb`);exact(`ARG WECHAT_${a.toUpperCase()}_URL=${v.url}`,`${a} URL`);exact(`ARG WECHAT_${a.toUpperCase()}_SHA256=${v.sha256}`,`${a} hash`);assert.ok(wrun.includes(`${a}) WECHAT_URL=`));}
for(const check of ['echo "$WECHAT_SHA256 /tmp/wechat.deb" | sha256sum --check --strict && test "$(dpkg-deb -f /tmp/wechat.deb Package)" = wechat','test "$(dpkg-deb -f /tmp/wechat.deb Version)" = "$WECHAT_VERSION"','test "$(dpkg-deb -f /tmp/wechat.deb Architecture)" = "$DEB_ARCH"'])assert.ok(wrun.includes(check),`WeChat semantic check missing: ${check}`);
for(const [copy,presence] of [['&& cp /opt/novnc/LICENSE.txt /opt/novnc/docs/LICENSE.* /usr/share/doc/agent-wechat/licenses/novnc/ &&','test -s /usr/share/doc/agent-wechat/licenses/novnc/LICENSE.txt'],['&& cp LICENSE.md /usr/share/doc/agent-wechat/licenses/sqlcipher/ &&','test -s /usr/share/doc/agent-wechat/licenses/sqlcipher/LICENSE.md']]){assert.ok(runs.some(x=>x.includes(copy)),`notice copy missing: ${copy}`);assert.ok(wrun.includes(presence));}
for(const p of ['docker/release-inputs.json','docker/release-instruction-allowlist.json','docker/release-materials/requirements.lock','docker/release-materials/frida_tools-14.10.4-py3-none-any.whl','scripts/validate-release-inputs.mjs','scripts/test-release-inputs.mjs','scripts/download-wechat.sh'])assert.ok(workflow.includes(`- '${p}'`),`workflow path missing: ${p}`);
console.log('Release inputs are semantically pinned, hash-bound, allowlisted, and notice-checked.');
