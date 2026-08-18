#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { queryGithubRelease } from "./github-release-state.mjs";
import { root, sha256Bytes, strictJson } from "./agent-release-lib.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

const index = process.argv.indexOf("--manifest");
if (index < 0 || !process.argv[index + 1]) throw new Error("usage: ensure-github-release.mjs --manifest <path>");
const manifestRaw = readFileSync(resolve(root, process.argv[index + 1]));
const manifest = verifyReleaseManifest(strictJson(manifestRaw.toString("utf8"), "release manifest"));
manifest.manifestSha256 = sha256Bytes(manifestRaw);
const before = queryGithubRelease(manifest);
if (before.state === "drift") throw new Error("existing GitHub Release identity drift");
if (before.state === "absent") execFileSync("gh", ["release", "create", manifest.tag, "--verify-tag", "--generate-notes", "--notes", `Agent-Release-Manifest-SHA256: ${manifest.manifestSha256}`, "--title", manifest.tag, "--target", manifest.commit], { stdio: "inherit" });
const after = queryGithubRelease(manifest);
if (after.state !== "exact") throw new Error("GitHub Release did not reconcile to exact final identity");
console.log(before.state === "exact" ? "exact GitHub Release already exists" : "exact GitHub Release created and verified");
