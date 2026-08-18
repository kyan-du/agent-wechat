#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { exactKeys, requireDigest, requireOid, strictJson } from "./agent-release-lib.mjs";

const [path = "release/stable-promotion.json"] = process.argv.slice(2);
const promotion = strictJson(readFileSync(path, "utf8"), "stable promotion receipt");
exactKeys(promotion, ["schemaVersion", "enabled", "stableVersion", "stableCommit", "stableTree", "sourcePrerelease", "allowedDiffPaths"], "stable promotion receipt");
if (promotion.schemaVersion !== 1 || promotion.enabled !== true) throw new Error("stable promotion is disabled pending exact owner confirmation and canary evidence");
if (!/^\d+\.\d+\.\d+$/.test(promotion.stableVersion ?? "")) throw new Error("stable version must be exact X.Y.Z");
requireOid(promotion.stableCommit, "stable commit");
requireOid(promotion.stableTree, "stable tree");
exactKeys(promotion.sourcePrerelease, ["version", "commit", "tree", "manifestSha256", "canaryReceiptSha256", "canaryPassedAt"], "source prerelease");
if (!/^\d+\.\d+\.\d+-next\.\d+$/.test(promotion.sourcePrerelease.version ?? "")) throw new Error("source prerelease version is invalid");
if (promotion.sourcePrerelease.version.split("-next.")[0] !== promotion.stableVersion) throw new Error("stable version does not promote the canary base version");
requireOid(promotion.sourcePrerelease.commit, "prerelease commit");
requireOid(promotion.sourcePrerelease.tree, "prerelease tree");
requireDigest(promotion.sourcePrerelease.manifestSha256, "prerelease manifest digest");
requireDigest(promotion.sourcePrerelease.canaryReceiptSha256, "canary receipt digest");
const passedAt = Date.parse(promotion.sourcePrerelease.canaryPassedAt);
if (!Number.isFinite(passedAt) || passedAt > Date.now()) throw new Error("canary pass timestamp is invalid");
const allowed = new Set(promotion.allowedDiffPaths);
for (const path of execFileSync("git", ["diff", "--name-only", promotion.sourcePrerelease.commit, promotion.stableCommit], { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
  if (allowed.has(path)) continue;
  if (/^(packages\/(cli|openclaw-extension|wechaty-puppet|wechaty-gateway|agent-server-rust)\/)(package\.json|CHANGELOG\.md)$/.test(path)) continue;
  throw new Error(`stable promotion contains unreviewed source drift: ${path}`);
}
console.log(`stable promotion ${promotion.stableVersion} is bound to canary ${promotion.sourcePrerelease.version}`);
