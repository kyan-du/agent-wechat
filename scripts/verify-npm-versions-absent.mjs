#!/usr/bin/env node
import { spawnSync } from "node:child_process";

export const packages = [
  "@kyan-du/agent-wechat-cli",
  "@kyan-du/agent-wechat-openclaw",
  "@kyan-du/agent-wechat-wechaty-puppet",
];

export function classifyNpmView(result, packageSpec) {
  if (result.status === 0) return { kind: "exists" };
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const notFound = /(?:^|\s)E404(?:\s|$)/.test(detail) &&
    /(?:is not in this registry|not found|404 Not Found)/i.test(detail) &&
    detail.includes(packageSpec);
  return notFound ? { kind: "absent" } : { kind: "error", detail };
}

export function verifyVersionsAbsent(version, run = spawnSync) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-next\.[0-9]+$/.test(version)) {
    throw new Error(`invalid next prerelease version: ${version}`);
  }
  const results = packages.map((name) => {
    const spec = `${name}@${version}`;
    const result = run("npm", ["view", spec, "version", "--json"], {
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_LOGLEVEL: "silent" },
    });
    return { spec, classification: classifyNpmView(result, spec) };
  });
  const exists = results.filter((item) => item.classification.kind === "exists");
  if (exists.length) throw new Error(`refusing duplicate publication: ${exists.map((item) => item.spec).join(", ")}`);
  const errors = results.filter((item) => item.classification.kind === "error");
  if (errors.length) {
    throw new Error(`npm registry preflight failed closed: ${errors.map((item) => item.spec).join(", ")}`);
  }
  return results;
}

if (process.argv[1]?.endsWith("verify-npm-versions-absent.mjs")) {
  const version = process.argv[2];
  verifyVersionsAbsent(version);
  console.log(`verified absent: ${packages.length} npm packages at ${version}`);
}
