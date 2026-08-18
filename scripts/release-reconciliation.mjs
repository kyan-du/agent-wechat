import { exactKeys } from "./agent-release-lib.mjs";

export const publicationStates = ["PREPARED", "AUTHORIZED", "PUBLISHING", "PARTIAL_PUBLICATION", "PUBLISHED", "CANARY_PASSED", "PROMOTED", "FAILED", "RECONCILED"];

export function classifyRegistryPackage(planned, remote) {
  if (!remote || remote.kind === "absent") return { name: planned.name, state: "missing" };
  if (remote.kind !== "exists") throw new Error(`${planned.name}: registry query failed closed`);
  if (remote.version !== planned.version || remote.integrity !== planned.integrity) {
    return { name: planned.name, state: "drift", remoteVersion: remote.version, remoteIntegrity: remote.integrity };
  }
  return { name: planned.name, state: "verified" };
}

export function reconcilePublication(manifest, remotePackages, currentDistTags = {}) {
  const remote = new Map(remotePackages.map((item) => [item.name, item]));
  if (remote.size !== remotePackages.length) throw new Error("duplicate remote package evidence");
  const packages = manifest.packages.map((planned) => classifyRegistryPackage(planned, remote.get(planned.name)));
  const unknown = remotePackages.filter((item) => !manifest.packages.some((planned) => planned.name === item.name));
  if (unknown.length) throw new Error(`unexpected registry package evidence: ${unknown.map((item) => item.name).join(", ")}`);
  const drift = packages.filter((item) => item.state === "drift");
  const verified = packages.filter((item) => item.state === "verified");
  const missing = packages.filter((item) => item.state === "missing");
  let state;
  let nextAction;
  if (drift.length) {
    state = "FAILED";
    nextAction = manifest.channel === "prerelease" ? "ABANDON_VERSION_AND_PREPARE_NEXT" : "INCIDENT_AND_OWNER_REVIEW";
  } else if (verified.length === packages.length) {
    state = "RECONCILED";
    nextAction = currentDistTags[manifest.distTag] === manifest.version ? "VERIFY_RELEASE_AND_POST_INSTALL" : "ADVANCE_DIST_TAGS_TOGETHER";
  } else if (verified.length) {
    state = "PARTIAL_PUBLICATION";
    nextAction = "PUBLISH_MISSING_ONLY_AFTER_ENVIRONMENT_APPROVAL";
  } else {
    state = "AUTHORIZED";
    nextAction = "PUBLISH_ALL_EXACT_ARTIFACTS";
  }
  return { schemaVersion: 1, state, release: { channel: manifest.channel, version: manifest.version, commit: manifest.commit, tree: manifest.tree }, packages, nextAction };
}

export function verifyResumeReceipt(receipt, manifest) {
  exactKeys(receipt, ["schemaVersion", "state", "release", "packages", "nextAction"], "reconciliation receipt");
  if (receipt.schemaVersion !== 1 || !publicationStates.includes(receipt.state)) throw new Error("invalid reconciliation state");
  exactKeys(receipt.release, ["channel", "version", "commit", "tree"], "reconciliation release");
  for (const key of ["channel", "version", "commit", "tree"]) if (receipt.release[key] !== manifest[key]) throw new Error(`reconciliation ${key} drift`);
  if (receipt.state !== "PARTIAL_PUBLICATION" && receipt.state !== "RECONCILED") throw new Error("receipt is not safe to resume");
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== manifest.packages.length) throw new Error("reconciliation package count drift");
  if (receipt.packages.some((item) => item.state === "drift")) throw new Error("registry drift forbids resume");
  const missing = receipt.packages.filter((item) => item.state === "missing").map((item) => item.name);
  const verified = receipt.packages.filter((item) => item.state === "verified").map((item) => item.name);
  if (new Set([...missing, ...verified]).size !== manifest.packages.length) throw new Error("reconciliation package identity drift");
  return { missing, verified };
}
