#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const expected=['@kyan-du/agent-wechat-cli','@kyan-du/agent-wechat-openclaw','@kyan-du/agent-wechat-wechaty-puppet'];
const forbiddenComponent=/^(cache|coverage|fixtures?|tmp|temp|\.data|node_modules)$/i;
const sensitiveSubstring=/(credential|secret|token)/i;
const sensitiveSegment=/(^|[-_.])env([-_.]|$)|environment|private[-_.]?key|api[-_.]?key|cert(?:ificate)?/i;
const captureSegment=/(^|[-_.])(qr|qrcode|screenshot)([-_.]|$)/i;
const forbiddenExtension=/\.(deb|rpm|apk|exe|dll|dylib|so(?:[.][0-9]+)*|node|a|o|db|sqlite|sqlite3|wal|shm|pem|key|p12|pfx|cer|crt|cert|log|tgz|tar|zip|gz|map)$/i;
function forbiddenPackedPath(path){
 const parts=path.split('/');
 return parts.some(part=>forbiddenComponent.test(part)||sensitiveSubstring.test(part)||sensitiveSegment.test(part)||captureSegment.test(part))||forbiddenExtension.test(parts.at(-1));
}
if(process.argv.includes('--test-forbidden-paths')){
 const forbidden=[
  'dist/mysecret.txt','dist/mycredential.txt','dist/mytoken.txt',
  'dist/.env.local','dist/myenvironment.txt','dist/my-private-key.txt',
  'dist/my-api-key.txt','dist/mycert.txt','dist/client.crt',
 ];
 const allowed=['dist/index.js','dist/formatter.js','dist/configuration.js','README.md'];
 for(const path of forbidden) if(!forbiddenPackedPath(path)) throw Error(`forbidden-path rule missed ${path}`);
 for(const path of allowed) if(forbiddenPackedPath(path)) throw Error(`forbidden-path rule rejected ${path}`);
 console.log(`Validated ${forbidden.length} forbidden and ${allowed.length} allowed packed-path fixtures.`);
 process.exit(0);
}
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','inherit']});
const workspaces=JSON.parse(run('pnpm',['-r','list','--depth','-1','--json']));
const found=[];
for(const ws of workspaces){
  const dir=ws.path; const file=join(dir,'package.json'); if(!existsSync(file)) throw Error(`workspace lacks package.json: ${relative(root,dir)}`);
  const p=JSON.parse(readFileSync(file));
  if(p.private===true) continue;
  if(p.private!==false && !('private' in p)) {
    // npm defaults to publishable: treat this as explicit audit scope, never skip it.
  }
  if(p.publishConfig?.access && p.publishConfig.access!=='public') throw Error(`${p.name}: ambiguous non-private publishConfig.access=${p.publishConfig.access}`);
  found.push({name:p.name,dir,file,p});
}
const names=found.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify([...expected].sort())) throw Error(`publishable workspace drift: expected ${expected.join(', ')}; found ${names.join(', ')}`);
function targets(p){
 const out=[]; const walk=x=>{if(typeof x==='string' && x.startsWith('./')) out.push(x.slice(2)); else if(x&&typeof x==='object') Object.values(x).forEach(walk)};
 walk(p.bin); walk(p.main); walk(p.types); walk(p.exports); return [...new Set(out)];
}
const report={schema:1,lockfile:'pnpm-lock.yaml',artifacts:[]};
for(const x of found.sort((a,b)=>a.name.localeCompare(b.name))){
 if(!Array.isArray(x.p.files)||!x.p.files.length) throw Error(`${x.name}: missing non-empty files allowlist`);
 const packed=JSON.parse(run('npm',['pack','--dry-run','--json'],x.dir));
 const paths=packed[0]?.files?.map(f=>f.path).sort()||[];
 if(!paths.length) throw Error(`${x.name}: empty pack report`);
 const bad=paths.filter(forbiddenPackedPath); if(bad.length) throw Error(`${x.name}: forbidden packed paths: ${bad.join(', ')}`);
 for(const t of targets(x.p)) if(!paths.includes(t)) throw Error(`${x.name}: declared target missing from pack: ${t}`);
 for(const allow of x.p.files.filter(v=>!v.startsWith('!'))){ const prefix=allow.replace(/^\.\//,'').replace(/\/$/,''); if(!paths.some(p=>p===prefix||p.startsWith(prefix+'/'))) throw Error(`${x.name}: required files entry has no packed output: ${allow}`); }
 const metaFile=join(x.dir,'dist/.release-metafile.json'); if(!existsSync(metaFile)) throw Error(`${x.name}: missing build metafile ${relative(root,metaFile)}`);
 const meta=JSON.parse(readFileSync(metaFile)); const bundled=new Map();
 for(const input of Object.keys(meta.inputs||{})){
   const marker=`node_modules${sep}`; const abs=resolve(x.dir,input); const i=abs.lastIndexOf(marker); if(i<0) continue;
   const rest=abs.slice(i+marker.length).split(sep); const pkg=rest[0].startsWith('@')?rest.slice(0,2).join('/'):rest[0];
   let d=dirname(abs), pj; while(d.startsWith(root)||d.includes(`${sep}node_modules${sep}`)){const f=join(d,'package.json');if(existsSync(f)){const q=JSON.parse(readFileSync(f));if(q.name===pkg){pj=q;break}} const n=dirname(d);if(n===d)break;d=n}
   bundled.set(pkg,{name:pkg,version:pj?.version||'UNKNOWN',license:pj?.license||'NOASSERTION'});
 }
 const depInfo=(name,specifier)=>{ let d=join(x.dir,'node_modules',...name.split('/')); const f=join(d,'package.json'); const p=existsSync(f)?JSON.parse(readFileSync(f)):{version:'UNRESOLVED',license:'NOASSERTION'}; return {name,specifier,version:p.version||'UNKNOWN',license:p.license||'NOASSERTION'}; };
 const runtime=Object.keys(x.p.dependencies||{}).filter(n=>!bundled.has(n)).map(name=>depInfo(name,x.p.dependencies[name]));
 const peer=Object.entries(x.p.peerDependencies||{}).map(([name,specifier])=>depInfo(name,specifier));
 const dev=Object.entries(x.p.devDependencies||{}).map(([name,specifier])=>depInfo(name,specifier));
 const projectFiles=paths.filter(p=>/\.py$/.test(p)).map(path=>({path,license:'BLOCKED: repository has no authoritative license grant'}));
 report.artifacts.push({name:x.name,packedPaths:paths,bundled:[...bundled.values()].sort((a,b)=>a.name.localeCompare(b.name)),externalRuntime:runtime,peer,dev,projectFiles});
 console.log(x.name); paths.forEach(p=>console.log(`  ${p}`));
}
const output=JSON.stringify(report,null,2)+'\n'; const dest=join(root,'docs/release-audit/npm-materials.json');
if(process.argv.includes('--write')) writeFileSync(dest,output); else {if(!existsSync(dest)||readFileSync(dest,'utf8')!==output) throw Error('npm material inventory is stale; run scripts/release-audit.mjs --write after an exact clean build');}
