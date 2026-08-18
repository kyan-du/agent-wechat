#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
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
const { missing } = verifyOperationReceipt(receipt, manifest, { operation });
const filenames = missing.map((name) => manifest.packages.find((item) => item.name === name)?.tarball);
if (filenames.some((value) => !value)) throw new Error("reconciliation references an unknown package");
writeFileSync(resolve(root, arg("--output")), filenames.length ? `${filenames.join("\n")}\n` : "", { flag: "wx" });
console.log(`selected ${filenames.length} missing exact artifact(s); zero safely skips npm publish`);
