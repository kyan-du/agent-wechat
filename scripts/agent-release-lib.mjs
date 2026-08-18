import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

export const root = resolve(import.meta.dirname, "..");
export const contract = JSON.parse(readFileSync(join(root, "release/agent-release-contract.json"), "utf8"));

export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function strictJson(raw, label = "JSON") {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be strict JSON`);
  }
  const document = parseDocument(raw, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length) throw new Error(`${label} has duplicate or ambiguous keys: ${document.errors[0].message}`);
  return value;
}

export function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys do not match the exact schema`);
  }
}

export function requireOid(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) throw new Error(`${label} must be a full lowercase Git OID`);
  return value;
}

export function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} must be a lowercase sha256 digest`);
  return value;
}

export function validateReleaseIdentity({ version, tag, distTag }) {
  if (!(new RegExp(contract.versionPattern)).test(version ?? "")) throw new Error(`stable version is invalid: ${version}`);
  if (tag !== `v${version}` || !(new RegExp(contract.tagPattern)).test(tag)) throw new Error("stable tag/version mismatch");
  if (distTag !== contract.distTag) throw new Error(`stable dist-tag must be ${contract.distTag}`);
  return contract;
}

export function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
