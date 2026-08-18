#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { exactKeys, requireDigest, requireOid, sha256Bytes, strictJson } from "./agent-release-lib.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

export const STABLE_PROMOTION_ALLOWED_PATHS = Object.freeze([
  ".changeset/pre.json",
  "release/agent-release-manifest.json",
  "release/npm-release-authorization.json",
  "release/stable-promotion.json",
]);
const VERSION_METADATA = /^(packages\/(cli|openclaw-extension|wechaty-puppet|wechaty-gateway|agent-server-rust)\/)(package\.json|CHANGELOG\.md)$/;

export function verifyStablePromotion(promotion, { read = readFileSync, git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim(), now = Date.now() } = {}) {
  exactKeys(promotion, ["schemaVersion", "enabled", "stableVersion", "stableCommit", "stableTree", "sourcePrerelease"], "stable promotion receipt");
  if (promotion.schemaVersion !== 2 || promotion.enabled !== true) throw new Error("stable promotion is disabled pending exact owner confirmation and canary evidence");
  if (!/^\d+\.\d+\.\d+$/.test(promotion.stableVersion ?? "")) throw new Error("stable version must be exact X.Y.Z");
  requireOid(promotion.stableCommit, "stable commit"); requireOid(promotion.stableTree, "stable tree");
  exactKeys(promotion.sourcePrerelease, ["version", "commit", "tree", "manifestPath", "manifestSha256", "canaryReceiptPath", "canaryReceiptSha256"], "source prerelease");
  const source = promotion.sourcePrerelease;
  if (!/^\d+\.\d+\.\d+-next\.\d+$/.test(source.version ?? "")) throw new Error("source prerelease version is invalid");
  if (source.version.split("-next.")[0] !== promotion.stableVersion) throw new Error("stable version does not promote the canary base version");
  requireOid(source.commit, "prerelease commit"); requireOid(source.tree, "prerelease tree");
  requireDigest(source.manifestSha256, "prerelease manifest digest"); requireDigest(source.canaryReceiptSha256, "canary receipt digest");
  if (!/^release\/evidence\/[A-Za-z0-9._-]+\.json$/.test(source.manifestPath ?? "") || !/^release\/evidence\/[A-Za-z0-9._-]+\.json$/.test(source.canaryReceiptPath ?? "")) throw new Error("stable provenance paths must use release/evidence JSON");

  const manifestRaw = read(source.manifestPath);
  if (sha256Bytes(manifestRaw) !== source.manifestSha256) throw new Error("prerelease manifest bytes do not match the stable receipt");
  const manifest = verifyReleaseManifest(strictJson(manifestRaw.toString("utf8"), "prerelease manifest"), { expectedChannel: "prerelease", expectedVersion: source.version, expectedCommit: source.commit });
  if (manifest.tree !== source.tree) throw new Error("prerelease manifest tree drift");
  const canaryRaw = read(source.canaryReceiptPath);
  if (sha256Bytes(canaryRaw) !== source.canaryReceiptSha256) throw new Error("canary receipt bytes do not match the stable receipt");
  const canary = strictJson(canaryRaw.toString("utf8"), "canary receipt");
  exactKeys(canary, ["schemaVersion", "state", "repository", "publisherWorkflow", "channel", "version", "commit", "tree", "manifestSha256", "passedAt"], "canary receipt");
  if (canary.schemaVersion !== 1 || canary.state !== "CANARY_PASSED" || canary.repository !== manifest.repository || canary.publisherWorkflow !== manifest.publisherWorkflow || canary.channel !== "prerelease") throw new Error("canary receipt identity drift");
  for (const [key, expected] of [["version", source.version], ["commit", source.commit], ["tree", source.tree], ["manifestSha256", source.manifestSha256]]) if (canary[key] !== expected) throw new Error(`canary receipt ${key} drift`);
  const passedAt = Date.parse(canary.passedAt);
  if (!Number.isFinite(passedAt) || passedAt > now) throw new Error("canary pass timestamp is invalid");

  if (git(["rev-parse", `${promotion.stableCommit}^{tree}`]) !== promotion.stableTree) throw new Error("stable commit tree drift");
  if (git(["rev-parse", `${source.commit}^{tree}`]) !== source.tree) throw new Error("source prerelease commit tree drift");
  const changed = git(["diff", "--name-only", source.commit, promotion.stableCommit]).split("\n").filter(Boolean);
  for (const path of changed) if (!STABLE_PROMOTION_ALLOWED_PATHS.includes(path) && !VERSION_METADATA.test(path)) throw new Error(`stable promotion contains unreviewed source drift: ${path}`);
  return { manifest, canary, changed };
}

if (process.argv[1]?.endsWith("verify-stable-promotion.mjs")) {
  const [path = "release/stable-promotion.json"] = process.argv.slice(2);
  const promotion = strictJson(readFileSync(path, "utf8"), "stable promotion receipt");
  verifyStablePromotion(promotion);
  console.log(`stable promotion ${promotion.stableVersion} is bound to canary ${promotion.sourcePrerelease.version}`);
}
