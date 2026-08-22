import { execFileSync } from "node:child_process";
export class CliUpgradeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const CLI_PACKAGE = "@kyan-du/agent-wechat-cli";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

type Version = { major: number; minor: number; patch: number; prerelease: string[] };

function parseVersion(value: string, source: string): Version {
  const match = SEMVER.exec(value);
  if (!match) throw new CliUpgradeError("CLI_UPGRADE_INVALID_VERSION", `${source} returned an invalid semantic version`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && (part.length > 1 && part.startsWith("0")))) {
    throw new CliUpgradeError("CLI_UPGRADE_INVALID_VERSION", `${source} returned an invalid semantic version`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

export function compareVersions(leftValue: string, rightValue: string): number {
  const left = parseVersion(leftValue, "installed CLI version");
  const right = parseVersion(rightValue, "npm latest");
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export type CliUpgrade = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  command?: string;
};

export function checkCliUpgrade(
  currentVersion: string,
  readLatest: () => string = () => execFileSync("npm", ["view", CLI_PACKAGE, "dist-tags.latest", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }),
): CliUpgrade {
  parseVersion(currentVersion, "installed CLI version");
  let rawLatest: string;
  try {
    rawLatest = readLatest();
  } catch {
    throw new CliUpgradeError("CLI_UPGRADE_REGISTRY_ERROR", "could not read npm latest for the CLI package");
  }
  let latest: unknown;
  try { latest = JSON.parse(rawLatest); } catch {
    throw new CliUpgradeError("CLI_UPGRADE_INVALID_VERSION", "npm latest returned an invalid semantic version");
  }
  if (typeof latest !== "string") throw new CliUpgradeError("CLI_UPGRADE_INVALID_VERSION", "npm latest returned an invalid semantic version");
  const parsedLatest = parseVersion(latest, "npm latest");
  if (parsedLatest.prerelease.length > 0) {
    throw new CliUpgradeError("CLI_UPGRADE_PRERELEASE_REJECTED", "npm latest unexpectedly points to a prerelease");
  }
  const comparison = compareVersions(currentVersion, latest);
  return {
    currentVersion,
    latestVersion: latest,
    updateAvailable: comparison < 0,
    ...(comparison < 0 ? { command: `npm install --global ${CLI_PACKAGE}@${latest}` } : {}),
  };
}
