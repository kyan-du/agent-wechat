#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireDigest, root, sha256Bytes, strictJson } from "./agent-release-lib.mjs";
import { verifyOperationReceipt } from "./release-reconciliation.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const manifest = verifyReleaseManifest(strictJson(readFileSync(resolve(root, arg("--manifest")), "utf8"), "release manifest"));
const receiptRaw = readFileSync(resolve(root, arg("--reconciliation")));
const receipt = strictJson(receiptRaw.toString("utf8"), "reconciliation receipt");
const operation = arg("--operation");
const expectedDigest = arg("--reconciliation-sha256");
if (operation === "reconcile") {
  requireDigest(expectedDigest, "authorized reconciliation digest");
  if (sha256Bytes(receiptRaw) !== expectedDigest) throw new Error("reconciliation artifact bytes do not match the authorized digest");
} else if (expectedDigest) throw new Error("fresh release must not carry a reconciliation digest");
const recovery = verifyOperationReceipt(receipt, manifest, { operation });
console.log(JSON.stringify({ operation, phase: receipt.phase, ...recovery }));
