#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("packages/openclaw-extension");
const target = resolve(process.argv[2] ?? ".artifacts/openclaw-extension");
if (!existsSync(resolve(source, "dist/index.js"))) {
  throw new Error("packages/openclaw-extension/dist/index.js is missing; run pnpm --filter @agent-wechat/wechat build first");
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
mkdirSync(resolve(target, "dist"));
cpSync(resolve(source, "dist/index.js"), resolve(target, "dist/index.js"));
cpSync(resolve(source, "openclaw.plugin.json"), resolve(target, "openclaw.plugin.json"));
const manifest = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
for (const field of ["scripts", "devDependencies", "publishConfig"]) delete manifest[field];
writeFileSync(resolve(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(target);
