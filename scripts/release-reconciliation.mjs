import { exactKeys, requireDigest, sha256Bytes } from "./agent-release-lib.mjs";

export const publicationStates = ["PREPARED", "AUTHORIZED", "PUBLISHING", "PARTIAL_PUBLICATION", "PUBLISHED", "CANARY_PASSED", "PROMOTED", "FAILED", "RECONCILED"];

export function classifyRegistryPackage(planned, remote) {
  if (!remote || remote.kind === "absent") return { name: planned.name, state: "missing" };
  if (remote.kind !== "exists") throw new Error(`${planned.name}: registry query failed closed`);
  if (remote.version !== planned.version || remote.integrity !== planned.integrity) {
    return { name: planned.name, state: "drift", remoteVersion: remote.version, remoteIntegrity: remote.integrity };
  }
  if (remote.provenance?.state !== "verified" || remote.provenance.repository !== "kyan-du/agent-wechat" || remote.provenance.workflow !== planned.publisherWorkflow || remote.provenance.commit !== planned.commit) {
    return { name: planned.name, state: "drift", remoteVersion: remote.version, remoteIntegrity: remote.integrity, provenance: remote.provenance ?? null };
  }
  return { name: planned.name, state: "verified" };
}

export function reconcilePublication(manifest, remotePackages, currentDistTags = {}, githubRelease = { state: "absent" }) {
  const remote = new Map(remotePackages.map((item) => [item.name, item]));
  if (remote.size !== remotePackages.length) throw new Error("duplicate remote package evidence");
  const packages = manifest.packages.map((planned) => classifyRegistryPackage({ ...planned, publisherWorkflow: manifest.publisherWorkflow, commit: manifest.commit }, remote.get(planned.name)));
  const unknown = remotePackages.filter((item) => !manifest.packages.some((planned) => planned.name === item.name));
  if (unknown.length) throw new Error(`unexpected registry package evidence: ${unknown.map((item) => item.name).join(", ")}`);
  const distTags = manifest.packages.map((planned) => ({
    name: planned.name,
    state: currentDistTags[planned.name] === manifest.version ? "verified" : "repair",
    current: currentDistTags[planned.name] ?? null,
  }));
  if (!new Set(["absent", "exact", "drift"]).has(githubRelease.state)) throw new Error("invalid GitHub Release evidence");
  const drift = packages.filter((item) => item.state === "drift");
  const verified = packages.filter((item) => item.state === "verified");
  let state;
  let phase;
  let nextAction;
  if (drift.length || githubRelease.state === "drift") {
    state = "FAILED";
    phase = "blocked";
    nextAction = manifest.channel === "prerelease" ? "ABANDON_VERSION_AND_PREPARE_NEXT" : "INCIDENT_AND_OWNER_REVIEW";
  } else if (verified.length !== packages.length) {
    state = verified.length ? "PARTIAL_PUBLICATION" : "AUTHORIZED";
    phase = "packages";
    nextAction = verified.length ? "PUBLISH_MISSING_ONLY_AFTER_RECONCILIATION_AUTHORIZATION" : "PUBLISH_ALL_EXACT_ARTIFACTS";
  } else if (distTags.some((item) => item.state === "repair")) {
    state = "RECONCILED";
    phase = "dist-tags";
    nextAction = "REPAIR_TARGET_DIST_TAGS";
  } else if (githubRelease.state === "absent") {
    state = "RECONCILED";
    phase = "github-release";
    nextAction = "CREATE_EXACT_GITHUB_RELEASE";
  } else {
    state = "RECONCILED";
    phase = "post-install";
    nextAction = "VERIFY_RELEASE_AND_POST_INSTALL";
  }
  return {
    schemaVersion: 2,
    state,
    phase,
    release: { channel: manifest.channel, version: manifest.version, commit: manifest.commit, tree: manifest.tree },
    packages,
    distTags,
    githubRelease,
    nextAction,
  };
}

export function reconciliationDigest(receipt) {
  return sha256Bytes(Buffer.from(`${JSON.stringify(receipt)}\n`));
}

export function verifyOperationReceipt(receipt, manifest, { operation, expectedDigest } = {}) {
  exactKeys(receipt, ["schemaVersion", "state", "phase", "release", "packages", "distTags", "githubRelease", "nextAction"], "reconciliation receipt");
  if (receipt.schemaVersion !== 2 || !publicationStates.includes(receipt.state)) throw new Error("invalid reconciliation state");
  exactKeys(receipt.release, ["channel", "version", "commit", "tree"], "reconciliation release");
  for (const key of ["channel", "version", "commit", "tree"]) if (receipt.release[key] !== manifest[key]) throw new Error(`reconciliation ${key} drift`);
  if (expectedDigest) {
    requireDigest(expectedDigest, "expected reconciliation digest");
    if (reconciliationDigest(receipt) !== expectedDigest) throw new Error("reconciliation receipt digest drift");
  }
  if (!new Set(["release", "reconcile"]).has(operation)) throw new Error("release operation is invalid");
  if (operation === "release") {
    if (receipt.state !== "AUTHORIZED" || receipt.phase !== "packages" || receipt.packages.some((item) => item.state !== "missing")) {
      throw new Error("fresh release requires all exact package versions to be absent");
    }
  } else if (!new Set(["PARTIAL_PUBLICATION", "RECONCILED"]).has(receipt.state)) {
    throw new Error("reconciliation operation requires partial or reconciled remote state");
  }
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== manifest.packages.length) throw new Error("reconciliation package count drift");
  if (receipt.packages.some((item) => item.state === "drift")) throw new Error("registry drift forbids resume");
  const missing = receipt.packages.filter((item) => item.state === "missing").map((item) => item.name);
  const verified = receipt.packages.filter((item) => item.state === "verified").map((item) => item.name);
  if (new Set([...missing, ...verified]).size !== manifest.packages.length) throw new Error("reconciliation package identity drift");
  return {
    missing,
    verified,
    repairDistTags: receipt.distTags.filter((item) => item.state === "repair").map((item) => item.name),
    createGithubRelease: receipt.githubRelease.state === "absent",
  };
}

export const verifyResumeReceipt = (receipt, manifest) => verifyOperationReceipt(receipt, manifest, { operation: "reconcile" });
