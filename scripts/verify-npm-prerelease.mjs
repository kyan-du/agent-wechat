#!/usr/bin/env node
import { readFileSync } from "node:fs";

const expectedVersion = process.argv[2];
if (!/^\d+\.\d+\.\d+-next\.\d+$/.test(expectedVersion ?? "")) {
  throw new Error("expected_version must be an exact next prerelease, e.g. 0.12.0-next.0");
}

const packages = [
  ["packages/cli/package.json", "@kyan-du/agent-wechat-cli"],
  ["packages/openclaw-extension/package.json", "@kyan-du/agent-wechat-openclaw"],
  ["packages/wechaty-puppet/package.json", "@kyan-du/agent-wechat-wechaty-puppet"],
];

for (const [path, name] of packages) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.name !== name) throw new Error(`${path}: expected ${name}, found ${manifest.name}`);
  if (manifest.private === true) throw new Error(`${name} must remain public`);
  if (manifest.version !== expectedVersion) throw new Error(`${name}: expected ${expectedVersion}, found ${manifest.version}`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    throw new Error(`${name}: public/provenance publishConfig is required`);
  }
}

console.log(`verified exact npm prerelease set: ${packages.map(([, name]) => `${name}@${expectedVersion}`).join(", ")}`);
