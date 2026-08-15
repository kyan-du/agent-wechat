#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const failures = [];
const requireRendered = process.argv.includes("--require-rendered");
const P1B_GATE = /P1-B[^\n]{0,120}(?:unavailable|not available|publishes?|verif)/i;
const OLD_NAMESPACE = /ghcr\.io\/thisnick\/agent-wechat/i;
const GHCR_LATEST = /ghcr\.io\/[\w./${}-]+(?::|\}:?)latest\b/i;
const INTERPOLATED_LATEST = /(?:FORK_IMAGE|IMAGE_REPO|REGISTRY_IMAGE)\}:latest\b/i;
const LOCAL_LATEST = /agent-wechat:latest\b/i;
const FIXED_FORK_VERSION = /ghcr\.io\/kyan-du\/agent-wechat:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/i;
const DEFAULT_CONTEXT = /(?:default|fallback|image[_a-z-]*\s*(?:=|:)|\$\{[^}\n]*(?::-|:-)[^}\n]*ghcr\.io)/i;
const FALLBACK_CONTEXT = /(?:fallback|default)[\w-]*\s*(?:=|:)[^\n]{0,160}(?:ghcr\.io|registry)|(?:ghcr\.io|registry)[^\n]{0,160}\?\?[^\n]{0,80}(?:fallback|default)/i;

function runtimeViolations(path, text) {
  const found = [];
  if (OLD_NAMESPACE.test(text)) found.push(`${path} references the old GHCR namespace`);
  if (GHCR_LATEST.test(text) || INTERPOLATED_LATEST.test(text) || LOCAL_LATEST.test(text)) found.push(`${path} references a mutable :latest image`);
  for (const line of text.split("\n")) {
    if (FIXED_FORK_VERSION.test(line) && DEFAULT_CONTEXT.test(line)) {
      found.push(`${path} defines a fixed published fork version as a runtime default`);
      break;
    }
  }
  if (FALLBACK_CONTEXT.test(text)) found.push(`${path} defines or describes a registry default/fallback`);
  return found;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".git") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function executableReleaseCommands(text, rendered = false) {
  if (rendered) {
    const blocks = [...text.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi)];
    const renderedCode = blocks.map((match) => match[1]
      .replace(/<[^>]+>/g, "")
      .replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")
      .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n")).join("\n");
    return /(?:npm\s+(?:i|install)(?:\s+-g)?|npx|openclaw\s+plugins\s+install)\b[^\n]*@kyan-du\/agent-wechat|(?:docker\s+pull|image\s*:)[^\n]*ghcr\.io\/kyan-du\/agent-wechat|^\s*wx(?:\s|$)|&&\s*wx(?:\s|$)/im.test(renderedCode) ? [1] : [];
  }
  const hits = [];
  let fenced = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced || line.trimStart().startsWith("#")) continue;
    if (/\b(?:npm\s+(?:i|install)(?:\s+-g)?|npx|openclaw\s+plugins\s+install)\b[^\n]*@kyan-du\/agent-wechat/i.test(line)
      || /(?:docker\s+pull|image\s*:)[^\n]*ghcr\.io\/kyan-du\/agent-wechat/i.test(line)
      || /^\s*wx(?:\s|$)/.test(line) || /&&\s*wx(?:\s|$)/.test(line)) {
      hits.push(index + 1);
    }
  }
  return hits;
}

function documentationViolations(path, text, rendered = false) {
  const found = [];
  if (!P1B_GATE.test(text)) found.push(`${path} does not state the P1-B release gate`);
  const hits = executableReleaseCommands(text, rendered);
  if (hits.length) found.push(`${path}:${hits.join(",")} contains executable unreleased-channel/bare-wx commands`);
  return found;
}

const workflows = readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name));
for (const name of workflows) {
  const path = join(".github/workflows", name);
  const text = readFileSync(path, "utf8");
  if (/docker\/login-action|push-by-digest|imagetools\s+create|push:\s*true|packages:\s*write/.test(text)) {
    failures.push(`${path} contains a Docker publication capability before P1-B/P1-C authorization`);
  }
  if (GHCR_LATEST.test(text) || LOCAL_LATEST.test(text)) failures.push(`${path} can reference or move :latest before first-release authorization`);
}

for (const path of ["src/cli.ts", "src/lib/session.ts", "packages/cli/src/cli.ts", "packages/cli/src/image-reference.ts", "docker-compose.yml"]) {
  failures.push(...runtimeViolations(path, readFileSync(path, "utf8")));
}

// Inspect exactly the Markdown files npm says it will put in every public package tarball.
for (const manifest of walk("packages").filter((path) => path.endsWith("package.json"))) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.private) continue;
  const cwd = dirname(manifest);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd, encoding: "utf8" }))[0];
  for (const entry of packed.files ?? []) {
    if (!/\.(?:md|mdx)$/i.test(entry.path)) continue;
    const path = join(cwd, entry.path);
    failures.push(...documentationViolations(path, readFileSync(path, "utf8")).map((failure) => `${failure} (publishable tarball)`));
  }
}

// Scan source docs and rendered output (when present); CI builds docs before this guard.
if (requireRendered && !existsSync("docs/dist")) failures.push("docs/dist is missing; build docs before the required rendered-output scan");
for (const root of ["docs/src/content", "docs/dist"]) {
  for (const path of walk(root).filter((p) => /\.(?:md|mdx|html)$/i.test(p))) {
    const text = readFileSync(path, "utf8");
    const rendered = path.endsWith(".html");
    const hasReleaseChannel = /@kyan-du\/agent-wechat|ghcr\.io\/kyan-du\/agent-wechat/i.test(text);
    if (hasReleaseChannel) failures.push(...documentationViolations(path, text, rendered));
    else {
      const hits = executableReleaseCommands(text, rendered);
      if (hits.length) failures.push(`${path}:${hits.join(",")} contains executable unreleased-channel/bare-wx commands`);
    }
  }
}

const documentationNegativeCases = [
  ["missing P1-B gate", "```bash\npnpm cli -- up\n```"],
  ["npm install", "> P1-B is not available until published and verified.\n```bash\nnpm install @kyan-du/agent-wechat-wechaty-puppet\n```"],
  ["npx", "> P1-B is not available until published and verified.\n```bash\nnpx @kyan-du/agent-wechat-cli up\n```"],
  ["plugin install", "> P1-B is not available until published and verified.\n```bash\nopenclaw plugins install @kyan-du/agent-wechat-openclaw\n```"],
  ["GHCR pull", "> P1-B is not available until published and verified.\n```bash\ndocker pull ghcr.io/kyan-du/agent-wechat:1.2.3\n```"],
  ["bare wx", "> P1-B is not available until published and verified.\n```bash\nwx up\n```"],
];
for (const [name, sample] of documentationNegativeCases) {
  if (documentationViolations(`<negative:${name}>`, sample).length === 0) failures.push(`documentation guard negative test failed: ${name}`);
}

const negativeCases = [
  ["old namespace", "const image = 'ghcr.io/thisnick/agent-wechat:1.2.3'"],
  ["latest", "image: ghcr.io/kyan-du/agent-wechat:latest"],
  ["interpolated latest", "const image = `${FORK_IMAGE}:latest`"],
  ["fixed default", "export AGENT_WECHAT_IMAGE=ghcr.io/kyan-du/agent-wechat:1.2.3"],
  ["fixed yaml default", "image: ghcr.io/kyan-du/agent-wechat:2.0.0-rc.1"],
  ["registry fallback", "const fallbackImage = registry + '/agent-wechat:' + version"],
  ["compose registry default", "image: ${IMAGE:-ghcr.io/kyan-du/agent-wechat:1.2.3}"],
];
for (const [name, sample] of negativeCases) {
  if (runtimeViolations(`<negative:${name}>`, sample).length === 0) failures.push(`guard negative test failed: ${name}`);
}

if (failures.length) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}
console.log("release boundary is fail-closed across workflows, runtimes, publishable tarball docs, and rendered/reference docs");
