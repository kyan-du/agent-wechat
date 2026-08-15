const FORK_IMAGE = "ghcr.io/kyan-du/agent-wechat";
const VERSION_TAG = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Accept only immutable, release-shaped references from the fork registry. */
export function validatePublishedImageReference(reference: string): string {
  const tagPrefix = `${FORK_IMAGE}:`;
  const digestPrefix = `${FORK_IMAGE}@`;
  if (reference.startsWith(tagPrefix) && VERSION_TAG.test(reference.slice(tagPrefix.length))) {
    return reference;
  }
  if (reference.startsWith(digestPrefix) && DIGEST.test(reference.slice(digestPrefix.length))) {
    return reference;
  }
  throw new Error(
    `Invalid image reference. Use ${FORK_IMAGE}:<semver> or ${FORK_IMAGE}@sha256:<64 lowercase hex characters>.`,
  );
}

export function localBuildImage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform !== "linux" && platform !== "darwin") return "agent-wechat:amd64";
  return `agent-wechat:${arch === "arm64" ? "arm64" : "amd64"}`;
}
