#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, strictJson } from "./agent-release-lib.mjs";
import { reconcilePublication } from "./release-reconciliation.mjs";
import { classifyNpmView } from "./verify-npm-versions-absent.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const manifestPath = arg("--manifest");
const outputPath = arg("--output");
if (!manifestPath || !outputPath) throw new Error("usage: reconcile-npm-release.mjs --manifest <path> --output <path> [--require-complete] [--require-dist-tags]");
const manifest = verifyReleaseManifest(strictJson(readFileSync(resolve(root, manifestPath), "utf8"), "release manifest"));
const remotePackages = [];
const currentDistTags = {};
for (const item of manifest.packages) {
  const spec = `${item.name}@${item.version}`;
  const result = spawnSync("npm", ["view", spec, "version", "dist.integrity", "--json"], { encoding: "utf8", env: { ...process.env, NPM_CONFIG_LOGLEVEL: "silent" } });
  const classification = classifyNpmView(result, spec);
  if (classification.kind === "absent") remotePackages.push({ name: item.name, kind: "absent" });
  else if (classification.kind === "error") remotePackages.push({ name: item.name, kind: "error" });
  else {
    let remote;
    try { remote = JSON.parse(result.stdout); } catch { throw new Error(`${spec}: malformed registry metadata`); }
    if (!remote || remote.version !== item.version || typeof remote["dist.integrity"] !== "string") throw new Error(`${spec}: incomplete registry metadata`);
    const provenance = spawnSync(process.execPath, ["scripts/verify-npm-provenance.mjs", "--package", item.name, "--version", item.version, "--repository", manifest.repository, "--workflow", manifest.publisherWorkflow, "--commit", manifest.commit, "--json"], { encoding: "utf8" });
    if (provenance.status !== 0) throw new Error(`${spec}: npm provenance verification failed closed`);
    remotePackages.push({ name: item.name, kind: "exists", version: remote.version, integrity: remote["dist.integrity"], provenance: JSON.parse(provenance.stdout) });
  }
  const tag = spawnSync("npm", ["view", item.name, `dist-tags.${manifest.distTag}`, "--json"], { encoding: "utf8", env: { ...process.env, NPM_CONFIG_LOGLEVEL: "silent" } });
  if (tag.status !== 0) throw new Error(`${item.name}: dist-tag query failed closed`);
  const value = JSON.parse(tag.stdout);
  currentDistTags[item.name] = typeof value === "string" ? value : null;
}
const receipt = reconcilePublication(manifest, remotePackages, currentDistTags);
if (process.argv.includes("--require-complete") && (receipt.packages.some((item) => item.state !== "verified") || receipt.state !== "RECONCILED")) throw new Error(`registry set is not complete: ${receipt.state}`);
if (process.argv.includes("--require-dist-tags") && Object.values(currentDistTags).some((value) => value !== manifest.version)) throw new Error(`registry ${manifest.distTag} mappings are not uniformly ${manifest.version}`);
writeFileSync(resolve(root, outputPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(`${receipt.state}: ${receipt.nextAction}`);
