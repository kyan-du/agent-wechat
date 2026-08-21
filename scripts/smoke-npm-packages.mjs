#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = [
  ["packages/cli", "@agent-wechat/cli"],
  ["packages/openclaw-extension", "@agent-wechat/wechat"],
];
const privateWorkspaceNames = new Set([
  "@kyan-du/agent-wechat-agent-server",
  "@kyan-du/agent-wechat-shared",
  "@kyan-du/agent-wechat-wechaty-gateway",
]);
const run = (command, args, cwd = root, options = {}) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
const stage = mkdtempSync(join(tmpdir(), "agent-wechat-npm-smoke-"));

try {
  for (const dir of ["shared", "cli", "openclaw-extension", "wechaty-puppet", "wechaty-gateway"]) {
    rmSync(join(root, "packages", dir, "dist"), { recursive: true, force: true });
  }
  // This must be the workspace build: Turbo's dependency graph builds shared first.
  run("pnpm", ["--filter", "!@kyan-du/agent-wechat-docs", "build"]);

  const tarballs = [];
  for (const [relativeDir, expectedName] of packages) {
    const dir = join(root, relativeDir);
    const dryRun = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], dir, { capture: true }))[0];
    if (dryRun.name !== expectedName || !dryRun.files?.length) throw new Error(`${expectedName}: incomplete npm pack dry-run`);
    const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", stage], dir, { capture: true }))[0];
    const tarball = join(stage, packed.filename);
    const manifest = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], root, { capture: true }));
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (String(spec).startsWith("workspace:")) throw new Error(`${expectedName}: ${field}.${name} contains workspace protocol`);
        if (privateWorkspaceNames.has(name)) throw new Error(`${expectedName}: ${field} contains private runtime dependency ${name}`);
      }
    }
    const listing = run("tar", ["-tf", tarball], root, { capture: true });
    if (!listing.includes("package/dist/")) throw new Error(`${expectedName}: packed tarball has no dist output`);
    tarballs.push(tarball);
  }

  const project = join(stage, "consumer");
  mkdirSync(project);
  run("npm", ["init", "-y"], project, { capture: true });
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...tarballs], project);
  run("node", [join(project, "node_modules/.bin/wx"), "--version"], project);
  // Import the extension entry without running setup or connecting to external services.
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "openclaw@^2026.5.12", "wechaty-puppet@^1.10.2"], project);
  run("node", ["--input-type=module", "-e", "await Promise.all([import('@agent-wechat/cli'), import('@agent-wechat/wechat')])"], project);

  console.log(`npm package smoke passed for ${tarballs.map((tarball) => basename(tarball)).join(", ")}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
