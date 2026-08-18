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

export function channelContract(channel) {
  const selected = contract.channels[channel];
  if (!selected) throw new Error(`unsupported release channel: ${channel}`);
  return selected;
}

export function validateReleaseIdentity({ channel, version, tag, distTag }) {
  const selected = channelContract(channel);
  if (!(new RegExp(selected.versionPattern)).test(version ?? "")) throw new Error(`${channel} version is invalid: ${version}`);
  if (tag !== `v${version}` || !(new RegExp(selected.tagPattern)).test(tag)) throw new Error(`${channel} tag/version mismatch`);
  if (distTag !== selected.distTag) throw new Error(`${channel} dist-tag must be ${selected.distTag}`);
  return selected;
}

export function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
