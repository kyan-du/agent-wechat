#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireDigest, requireOid, sha256Bytes, strictJson } from "./agent-release-lib.mjs";
import { verifyAuthorizationReceipt } from "./release-authorization.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

const [manifestPathArg, releaseCommit, receiptRef, expectedReceiptCommit, expectedReceiptTagOid, authorizationId] = process.argv.slice(2);
const skipConsumptionLookup = process.argv.includes("--skip-consumption-lookup");
if (![manifestPathArg, releaseCommit, receiptRef, expectedReceiptCommit, expectedReceiptTagOid, authorizationId].every(Boolean)) {
  throw new Error("usage: verify-npm-release-authorization.mjs <manifest> <release-commit> <receipt-ref> <receipt-commit> <receipt-tag-oid> <authorization-id>");
}
requireOid(releaseCommit, "release commit");
requireOid(expectedReceiptCommit, "receipt commit");
requireOid(expectedReceiptTagOid, "receipt tag object");
if (!/^[0-9a-f]{32}$/.test(authorizationId)) throw new Error("authorization identity must be exact lowercase hex");
if (!/^refs\/tags\/npm-release-auth\/v[0-9]+\.[0-9]+\.[0-9]+(?:-next\.[0-9]+)?\/[0-9a-f]{32}$/.test(receiptRef)) throw new Error("authorization must use the protected exact receipt namespace");
const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const receiptShort = receiptRef.slice("refs/tags/".length);
if (spawnSync("git", ["show-ref", "--verify", `refs/heads/${receiptShort}`]).status === 0) throw new Error("authorization receipt name is ambiguous with a branch");
if (run(["rev-parse", receiptRef]) !== expectedReceiptTagOid) throw new Error("authorization receipt tag object does not match the protected exact OID");
const tagObject = run(["cat-file", "-p", expectedReceiptTagOid]);
const target = tagObject.match(/^object ([0-9a-f]{40})$/m)?.[1];
if (run(["cat-file", "-t", expectedReceiptTagOid]) !== "tag" || target !== expectedReceiptCommit || run(["cat-file", "-t", target]) !== "commit") {
  throw new Error("authorization receipt must be exactly one annotated tag to the configured commit");
}
execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, expectedReceiptCommit], { stdio: "ignore" });
execFileSync("git", ["merge-base", "--is-ancestor", expectedReceiptCommit, "origin/main"], { stdio: "ignore" });
const receiptPath = "release/npm-release-authorization.json";
const entry = run(["ls-tree", expectedReceiptCommit, "--", receiptPath]).split(/\s+/);
if (entry.length !== 4 || entry[0] !== "100644" || entry[1] !== "blob" || entry[3] !== receiptPath) throw new Error("authorization receipt must be one regular mode-100644 blob");
const receipt = strictJson(run(["show", `${expectedReceiptCommit}:${receiptPath}`]), "authorization receipt");
if (receipt.authorizationId !== authorizationId || receiptRef !== `refs/tags/npm-release-auth/${receipt.release.tag}/${authorizationId}`) throw new Error("authorization ref identity drift");
const manifestRaw = readFileSync(resolve(manifestPathArg));
const manifestSha256 = sha256Bytes(manifestRaw);
const manifest = verifyReleaseManifest(strictJson(manifestRaw.toString("utf8"), "release manifest"), { expectedCommit: releaseCommit });
if (run(["rev-parse", `${releaseCommit}^{tree}`]) !== manifest.tree) throw new Error("release commit tree does not match the reviewed manifest");
const consumptionRef = `refs/tags/${receipt.consumption.tag}`;
const consumptionRefExists = skipConsumptionLookup ? false : spawnSync("git", ["ls-remote", "--exit-code", "origin", consumptionRef], { stdio: "ignore" }).status === 0;
verifyAuthorizationReceipt(receipt, manifest, {
  nonce: process.env.RELEASE_AUTHORIZATION_NONCE,
  now: process.env.RELEASE_AUTHORIZATION_NOW,
  manifestSha256,
  consumptionRefExists,
  operation: process.env.RELEASE_OPERATION,
  reconciliationSha256: process.env.RELEASE_RECONCILIATION_SHA256,
  skipConsumptionState: skipConsumptionLookup,
});
console.log(`release authorized for ${manifest.tag} at ${releaseCommit} by ${authorizationId}`);
