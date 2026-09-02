import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const publicPackages = [
  { name: "@kyan-du/agent-wechat-cli", tarball: (version) => `kyan-du-agent-wechat-cli-${version}.tgz` },
  { name: "@kyan-du/agent-wechat-openclaw", tarball: (version) => `kyan-du-agent-wechat-openclaw-${version}.tgz` },
  { name: "@kyan-du/agent-wechat-wechaty-puppet", tarball: (version) => `kyan-du-agent-wechat-wechaty-puppet-${version}.tgz` },
];

export const exactStableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const transientCodes = new Set([
  "E404",
  "E500",
  "E502",
  "E503",
  "E504",
  "ETARGET",
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "ERR_SOCKET_TIMEOUT",
  "FETCH_ERROR",
]);
const registry = process.env.NPM_CONFIG_REGISTRY || process.env.npm_config_registry || "https://registry.npmjs.org";

export function run(command, args, cwd = process.cwd(), options = {}) {
  const stdio = options.capture ? ["ignore", "pipe", "pipe"] : "inherit";
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio });
}

export function runResult(command, args, cwd = process.cwd()) {
  try {
    return { ok: true, stdout: run(command, args, cwd, { capture: true }), stderr: "", status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      status: typeof error.status === "number" ? error.status : 1,
      error,
    };
  }
}

export function classifyNpmFailure(result) {
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const code = text.match(/\bnpm ERR! code ([A-Z0-9_]+)/)?.[1]
    ?? text.match(/\bnpm error code ([A-Z0-9_]+)/i)?.[1]
    ?? text.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]+)"/)?.[1]
    ?? text.match(/\b(?:code|statusCode|error)\s*[=:]\s*['"]?([A-Z][A-Z0-9_]+)\b/)?.[1]
    ?? "";
  const transient = transientCodes.has(code) || /\b(?:404 Not Found|5\d\d|not in this registry|No matching version found|No match found for version|network timeout|socket timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.test(text);
  const alreadyExists = /\b(?:E403|EPUBLISHCONFLICT)\b/i.test(text) || /cannot publish over the previously published versions|You cannot publish over the previously published versions/i.test(text);
  return { code, transient, alreadyExists, text: text.trim() };
}

export async function retryTransient(description, operation, options = {}) {
  const attempts = options.attempts ?? 7;
  const initialDelayMs = options.initialDelayMs ?? 3_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let lastResult;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await operation(attempt);
    if (result?.ok) return result;
    lastResult = result;
    const failure = classifyNpmFailure(result ?? {});
    if (!failure.transient) {
      throw new Error(`${description} failed with non-transient npm error${failure.code ? ` ${failure.code}` : ""}\n${failure.text}`);
    }
    if (attempt === attempts) break;
    const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
    console.warn(`${description} not ready (${failure.code || "transient"}); retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${attempts})`);
    await sleep(delayMs);
  }

  const failure = classifyNpmFailure(lastResult ?? {});
  throw new Error(`${description} stayed unavailable after ${attempts} attempts${failure.code ? ` (${failure.code})` : ""}\n${failure.text}`);
}

export async function viewPackage(name, version, options = {}) {
  const result = await retryTransient(
    `npm view ${name}@${version}`,
    () => runResult("npm", ["view", `${name}@${version}`, "--json", "--registry", registry]),
    options,
  );
  const metadata = JSON.parse(result.stdout);
  if (metadata.name !== name || metadata.version !== version) {
    throw new Error(`registry returned ${metadata.name}@${metadata.version} for ${name}@${version}`);
  }
  if (!metadata.dist?.tarball || !metadata.dist?.integrity) {
    throw new Error(`${name}@${version}: registry metadata is missing tarball or integrity`);
  }
  return metadata;
}

export function sha512Base64(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

export function integrityFromTarball(path) {
  return `sha512-${sha512Base64(path)}`;
}

export function tarballPath(packDir, item, version) {
  return join(packDir, item.tarball(version));
}

export function verifyTarballIntegrity(localTarball, metadata) {
  const localIntegrity = integrityFromTarball(localTarball);
  if (metadata.dist.integrity !== localIntegrity) {
    throw new Error(
      `${metadata.name}@${metadata.version} already exists on npm with different content: registry ${metadata.dist.integrity}, candidate ${localIntegrity}`,
    );
  }
  return localIntegrity;
}

export async function verifyPublishedTarballMatches(name, version, localTarball, options = {}) {
  const metadata = await viewPackage(name, version, options);
  const integrity = verifyTarballIntegrity(localTarball, metadata);
  console.log(`${name}@${version} already exists on npm with matching integrity ${integrity}; skipping publish`);
  return metadata;
}

export async function ensurePublishedOrPublish(item, version, packDir, options = {}) {
  const localTarball = tarballPath(packDir, item, version);
  const existing = runResult("npm", ["view", `${item.name}@${version}`, "--json", "--registry", registry]);
  if (existing.ok) {
    const metadata = JSON.parse(existing.stdout);
    if (metadata.name !== item.name || metadata.version !== version) {
      throw new Error(`registry returned ${metadata.name}@${metadata.version} for ${item.name}@${version}`);
    }
    verifyTarballIntegrity(localTarball, metadata);
    console.log(`${item.name}@${version} already exists on npm with matching candidate tarball; skipping publish`);
    return "skipped";
  }

  const existingFailure = classifyNpmFailure(existing);
  if (!existingFailure.transient) {
    throw new Error(`npm view ${item.name}@${version} failed before publish with non-transient npm error${existingFailure.code ? ` ${existingFailure.code}` : ""}\n${existingFailure.text}`);
  }

  const publish = runResult("npm", ["publish", localTarball, "--access", "public", "--provenance"]);
  if (publish.ok) return "published";

  const publishFailure = classifyNpmFailure(publish);
  if (!publishFailure.alreadyExists && !publishFailure.transient) {
    throw new Error(`npm publish ${basename(localTarball)} failed with non-transient npm error${publishFailure.code ? ` ${publishFailure.code}` : ""}\n${publishFailure.text}`);
  }

  console.warn(`npm publish ${basename(localTarball)} did not complete cleanly; reconciling against the public registry before continuing`);
  await verifyPublishedTarballMatches(item.name, version, localTarball, options);
  return "reconciled";
}

export function cleanInstallPublished(version) {
  const dir = mkdtempSync(join(tmpdir(), "agent-wechat-production-smoke-"));
  try {
    run("npm", ["init", "-y"], dir, { capture: true });
    run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", ...publicPackages.map((item) => `${item.name}@${version}`)], dir);
    run("node", [join(dir, "node_modules/.bin/wx"), "--version"], dir);
    run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "openclaw@^2026.5.12"], dir);
    run("node", ["--input-type=module", "-e", "await Promise.all([import('@kyan-du/agent-wechat-openclaw'), import('@kyan-du/agent-wechat-wechaty-puppet')])"], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version, packDir = ".release-pack"] = process.argv.slice(2);
  if (command !== "publish-existing-safe" || !exactStableVersionPattern.test(version ?? "")) {
    throw new Error("usage: npm-release-utils.mjs publish-existing-safe <exact stable version> [pack-dir]");
  }
  for (const item of publicPackages) {
    await ensurePublishedOrPublish(item, version, packDir);
  }
}
