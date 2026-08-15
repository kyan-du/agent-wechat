#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const failures = [];
const OLD_NAMESPACE = /ghcr\.io\/thisnick\/agent-wechat/i;
const LATEST_IMAGE = /(?:ghcr\.io\/[^\s"'`]+|agent-wechat):latest\b/i;
const FIXED_FORK_DEFAULT = /(?:DEFAULT|FALLBACK|IMAGE|image)\w*\s*(?:=|:)\s*["'`]ghcr\.io\/kyan-du\/agent-wechat:\d+\.\d+\.\d+/i;
const REGISTRY_FALLBACK = /(?:fallback|default)[^\n]{0,100}ghcr\.io\/|ghcr\.io\/[^\n]{0,100}(?:fallback|default)/i;

function runtimeViolations(path, text) {
  const found = [];
  if (OLD_NAMESPACE.test(text)) found.push(`${path} references the old GHCR namespace`);
  if (LATEST_IMAGE.test(text)) found.push(`${path} references a mutable :latest image`);
  if (FIXED_FORK_DEFAULT.test(text)) found.push(`${path} defines a fixed published fork version as a runtime default`);
  if (REGISTRY_FALLBACK.test(text)) found.push(`${path} defines or describes a registry default/fallback`);
  return found;
}
const workflows = readdirSync(".github/workflows").filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
for (const name of workflows) {
  const path = join(".github/workflows", name);
  const text = readFileSync(path, "utf8");
  const dockerPublisher = /docker\/login-action|push-by-digest|imagetools\s+create|push:\s*true|packages:\s*write/.test(text);
  const movesLatest = LATEST_IMAGE.test(text);
  if (dockerPublisher) failures.push(`${path} contains a Docker publication capability before P1-B/P1-C authorization`);
  if (movesLatest) failures.push(`${path} can reference or move :latest before first-release authorization`);
}

for (const path of ["src/cli.ts", "src/lib/session.ts", "packages/cli/src/cli.ts", "packages/cli/src/image-reference.ts", "docker-compose.yml"]) {
  failures.push(...runtimeViolations(path, readFileSync(path, "utf8")));
}

const negativeCases = [
  ["old namespace", "const image = 'ghcr.io/thisnick/agent-wechat:1.2.3'"],
  ["latest", "image: ghcr.io/kyan-du/agent-wechat:latest"],
  ["fixed default", "const DEFAULT_IMAGE = 'ghcr.io/kyan-du/agent-wechat:1.2.3'"],
  ["registry fallback", "const fallbackImage = 'ghcr.io/kyan-du/agent-wechat:' + version"],
];
for (const [name, sample] of negativeCases) {
  if (runtimeViolations(`<negative:${name}>`, sample).length === 0) failures.push(`guard negative test failed: ${name}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("release boundary is fail-closed: no publication, registry default/fallback, :latest, fixed fork default, or old namespace");
