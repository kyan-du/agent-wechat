#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const failures = [];
const workflows = readdirSync(".github/workflows").filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
for (const name of workflows) {
  const path = join(".github/workflows", name);
  const text = readFileSync(path, "utf8");
  const dockerPublisher = /docker\/login-action|push-by-digest|imagetools\s+create|push:\s*true|packages:\s*write/.test(text);
  const movesLatest = /(?:^|[\s"'])[^\s"']*:latest(?:[\s"']|$)/m.test(text);
  if (dockerPublisher) failures.push(`${path} contains a Docker publication capability before P1-B/P1-C authorization`);
  if (movesLatest) failures.push(`${path} can reference or move :latest before first-release authorization`);
}

const forbiddenRuntime = "ghcr.io/kyan-du/agent-wechat:0.11.15";
for (const path of ["src/cli.ts", "src/lib/session.ts"]) {
  if (readFileSync(path, "utf8").includes(forbiddenRuntime)) {
    failures.push(`${path} retains the nonexistent legacy GHCR default`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("release boundary is fail-closed: no Docker publication/latest movement or dead root-CLI default");
