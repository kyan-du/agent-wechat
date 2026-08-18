#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, strictJson } from "./agent-release-lib.mjs";
import { verifyResumeReceipt } from "./release-reconciliation.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

function arg(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const manifest = verifyReleaseManifest(strictJson(readFileSync(resolve(root, arg("--manifest")), "utf8"), "release manifest"));
const receipt = strictJson(readFileSync(resolve(root, arg("--reconciliation")), "utf8"), "reconciliation receipt");
let missing;
if (receipt.state === "AUTHORIZED") missing = receipt.packages.filter((item) => item.state === "missing").map((item) => item.name);
else ({ missing } = verifyResumeReceipt(receipt, manifest));
if (!missing.length) throw new Error("no missing package artifact is safe to publish");
const filenames = missing.map((name) => manifest.packages.find((item) => item.name === name)?.tarball);
if (filenames.some((value) => !value)) throw new Error("reconciliation references an unknown package");
writeFileSync(resolve(root, arg("--output")), `${filenames.join("\n")}\n`, { flag: "wx" });
console.log(`selected ${filenames.length} missing exact artifact(s)`);
