const FORK_IMAGE = "ghcr.io/kyan-du/agent-wechat";
const VERSION_TAG = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function localBuildImage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform !== "linux" && platform !== "darwin") return "agent-wechat:amd64";
  return `agent-wechat:${arch === "arm64" ? "arm64" : "amd64"}`;
}

export function validateImageReference(reference: string): string {
  if (reference === "agent-wechat:arm64" || reference === "agent-wechat:amd64") return reference;

  const tagPrefix = `${FORK_IMAGE}:`;
  const digestPrefix = `${FORK_IMAGE}@`;
  if (reference.startsWith(tagPrefix) && VERSION_TAG.test(reference.slice(tagPrefix.length))) return reference;
  if (reference.startsWith(digestPrefix) && DIGEST.test(reference.slice(digestPrefix.length))) return reference;

  throw new Error(
    `Invalid image reference. Use agent-wechat:arm64, agent-wechat:amd64, ${FORK_IMAGE}:<semver>, or ${FORK_IMAGE}@sha256:<64 lowercase hex characters>.`,
  );
}

export function migrateSessionImage(reference: string): { image: string; migrated: boolean } {
  const staleDefaults = new Set([
    "ghcr.io/agent-wechat/agent-wechat:latest",
    "ghcr.io/kyan-du/agent-wechat:latest",
    "ghcr.io/kyan-du/agent-wechat:0.11.15",
    "ghcr.io/thisnick/agent-wechat:latest",
    "ghcr.io/thisnick/agent-wechat:0.11.15",
  ]);
  if (staleDefaults.has(reference)) return { image: localBuildImage(), migrated: true };
  return { image: validateImageReference(reference), migrated: false };
}
