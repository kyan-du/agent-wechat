import { timingSafeEqual } from "node:crypto";
import { contract, exactKeys, requireDigest, requireOid, sha256Bytes, validateReleaseIdentity } from "./agent-release-lib.mjs";
import { verifyReleaseManifest } from "./verify-agent-release.mjs";

const topKeys = ["schemaVersion", "enabled", "repository", "channel", "authorizationId", "operation", "reconciliationSha256", "nonceSha256", "ownerConfirmationRefSha256", "issuedAt", "expiresAt", "release", "intent", "approvals", "consumption"];
const approvalKeys = contract.authorization.requiredApprovals;

function safeEqual(left, right) {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAuthorizationReceipt(receipt, manifest, options = {}) {
  exactKeys(receipt, topKeys, "authorization receipt");
  if (receipt.schemaVersion !== 2 || receipt.enabled !== true) throw new Error("release authorization is disabled");
  if (receipt.repository !== contract.repository || receipt.repository !== manifest.repository) throw new Error("authorization repository drift");
  if (receipt.channel !== manifest.channel) throw new Error("authorization channel drift");
  if (!/^[0-9a-f]{32}$/.test(receipt.authorizationId ?? "")) throw new Error("authorizationId must be an opaque 128-bit lowercase hex identity");
  if (!new Set(["release", "reconcile"]).has(receipt.operation)) throw new Error("authorization operation must be release or reconcile");
  if (receipt.operation === "reconcile") requireDigest(receipt.reconciliationSha256, "reconciliation receipt digest");
  else if (receipt.reconciliationSha256 !== null) throw new Error("fresh release must not carry reconciliation identity");
  if (options.operation && receipt.operation !== options.operation) throw new Error("authorization operation drift");
  if (options.reconciliationSha256 && receipt.reconciliationSha256 !== options.reconciliationSha256) throw new Error("authorization reconciliation receipt drift");
  requireDigest(receipt.nonceSha256, "nonce digest");
  requireDigest(receipt.ownerConfirmationRefSha256, "owner confirmation reference digest");
  if (!options.nonce) throw new Error("authorization nonce is required at dispatch and must not be stored in the receipt");
  if (!safeEqual(sha256Bytes(Buffer.from(options.nonce)), receipt.nonceSha256)) throw new Error("authorization nonce mismatch");

  const issued = Date.parse(receipt.issuedAt);
  const expires = Date.parse(receipt.expiresAt);
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (![issued, expires, now].every(Number.isFinite) || expires <= issued || expires - issued > contract.authorization.maximumLifetimeSeconds * 1000) {
    throw new Error("authorization lifetime is invalid");
  }
  if (now < issued || now >= expires) throw new Error("authorization is not currently valid");

  exactKeys(receipt.release, ["tag", "commit", "tree", "manifestSha256"], "authorization release");
  requireOid(receipt.release.commit, "authorized release commit");
  requireOid(receipt.release.tree, "authorized release tree");
  requireDigest(receipt.release.manifestSha256, "authorized manifest digest");
  if (receipt.release.tag !== manifest.tag || receipt.release.commit !== manifest.commit || receipt.release.tree !== manifest.tree) throw new Error("authorization release identity drift");
  if (options.manifestSha256 && receipt.release.manifestSha256 !== options.manifestSha256) throw new Error("authorization manifest digest drift");

  exactKeys(receipt.intent, ["registry", "distTag", "packages"], "authorization intent");
  validateReleaseIdentity({ channel: receipt.channel, version: manifest.version, tag: receipt.release.tag, distTag: receipt.intent.distTag });
  if (receipt.intent.registry !== manifest.registry || receipt.intent.registry !== contract.registry) throw new Error("authorization registry drift");
  if (!Array.isArray(receipt.intent.packages) || receipt.intent.packages.length !== manifest.packages.length) throw new Error("authorization package count drift");
  for (let index = 0; index < manifest.packages.length; index += 1) {
    const authorized = receipt.intent.packages[index];
    const planned = manifest.packages[index];
    exactKeys(authorized, ["name", "version", "tarball", "sha256", "integrity"], `authorized package ${index}`);
    for (const key of ["name", "version", "tarball", "sha256", "integrity"]) {
      if (authorized[key] !== planned[key]) throw new Error(`authorization package ${key} drift`);
    }
  }

  exactKeys(receipt.approvals, approvalKeys, "authorization approvals");
  for (const gate of approvalKeys) if (receipt.approvals[gate] !== true) throw new Error(`release gate is not approved: ${gate}`);
  exactKeys(receipt.consumption, ["state", "tag"], "authorization consumption");
  if (receipt.consumption.state !== "unused" || receipt.consumption.tag !== `npm-release-consumed/${receipt.release.tag}/${receipt.authorizationId}`) {
    throw new Error("authorization receipt is replayed or has invalid consumption identity");
  }
  if (options.skipConsumptionState !== true) {
    if (options.consumptionRefExists === true && receipt.operation !== "reconcile") throw new Error("authorization receipt has already been consumed");
    if (options.consumptionRefExists !== true && receipt.operation === "reconcile") throw new Error("reconcile requires the exact prior consumption marker");
  }

  verifyReleaseManifest(manifest, { expectedChannel: receipt.channel, expectedVersion: manifest.version, expectedCommit: receipt.release.commit });
  return receipt;
}
