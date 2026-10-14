#!/usr/bin/env node
// Build GitHub Release notes for a fixed-group version from the changesets-generated
// package CHANGELOG.md files. Entries shared by several packages are listed once.
// Usage: node scripts/release-notes.mjs <version> [outFile]
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECTIONS = ["Major Changes", "Minor Changes", "Patch Changes"];

export function extractVersionSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n");
}

export function parseEntries(section) {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  let current = null;
  let entry = null;
  const flush = () => {
    if (entry && current) out[current].push(entry.trimEnd());
    entry = null;
  };
  for (const line of section.split("\n")) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      flush();
      current = SECTIONS.includes(heading[1].trim()) ? heading[1].trim() : null;
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      entry = line;
    } else if (entry !== null && (line.startsWith("  ") || line.trim() === "")) {
      entry += `\n${line}`;
    }
  }
  flush();
  return out;
}

export function buildReleaseNotes(version, changelogs) {
  const merged = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  const packages = [];
  for (const { name, text } of changelogs) {
    const section = extractVersionSection(text, version);
    if (section === null) continue;
    packages.push(name);
    const entries = parseEntries(section);
    for (const s of SECTIONS) {
      for (const e of entries[s]) {
        // Dependency-bump bullets are noise in release notes.
        if (/^- Updated dependencies/.test(e)) continue;
        if (!merged[s].includes(e)) merged[s].push(e);
      }
    }
  }
  if (packages.length === 0) {
    throw new Error(`no CHANGELOG.md contains a "## ${version}" section`);
  }
  const parts = [];
  for (const s of SECTIONS) {
    if (merged[s].length) parts.push(`### ${s}\n\n${merged[s].join("\n\n")}`);
  }
  if (parts.length === 0) parts.push("_No user-facing changes; version aligned with the fixed release group._");
  parts.push(`**Packages:** ${packages.map((p) => `\`${p}@${version}\``).join(", ")}`);
  return `${parts.join("\n\n")}\n`;
}

function loadChangelogs(root = "packages") {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .filter((dir) => existsSync(join(dir, "CHANGELOG.md")) && existsSync(join(dir, "package.json")))
    .map((dir) => ({
      name: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name,
      text: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, outFile] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("usage: release-notes.mjs <X.Y.Z> [outFile]");
    process.exit(2);
  }
  const notes = buildReleaseNotes(version, loadChangelogs());
  if (outFile) writeFileSync(outFile, notes);
  else process.stdout.write(notes);
}
