#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
digest="sha256:$(printf 'a%.0s' {1..64})"
first=$(mktemp /tmp/agent-wechat-manifest-first.XXXXXX.json)
second=$(mktemp /tmp/agent-wechat-manifest-second.XXXXXX.json)
rm -f "$first" "$second"
cleanup() {
  rm -f "$first" "$second"
  rm -rf packages/shared/dist packages/cli/dist packages/openclaw-extension/dist packages/wechaty-puppet/dist
}
trap cleanup EXIT

node --test scripts/prerelease-state.test.mjs

# The canonical stage must build from a clean source tree with no checkout dist.
rm -rf packages/shared/dist packages/cli/dist packages/openclaw-extension/dist packages/wechaty-puppet/dist
node scripts/generate-prerelease-manifest.mjs --image-digest "$digest" --output "$first" >/dev/null

# Untracked checkout residue must not change package evidence at the same commit.
mkdir -p packages/shared/dist packages/cli/dist packages/openclaw-extension/dist packages/wechaty-puppet/dist
printf 'checkout contamination\n' > packages/shared/dist/index.js
printf 'checkout contamination\n' > packages/cli/dist/cli.js
printf 'checkout contamination\n' > packages/openclaw-extension/dist/index.js
printf 'checkout contamination\n' > packages/wechaty-puppet/dist/mod.js
node scripts/generate-prerelease-manifest.mjs --image-digest "$digest" --output "$second" >/dev/null
node - "$first" "$second" <<'NODE'
const fs = require("node:fs");
const [first, second] = process.argv.slice(2).map((path) => JSON.parse(fs.readFileSync(path, "utf8")));
const evidence = (manifest) => manifest.packages.map(({ name, proposedVersion, tarball, integrity, shasum, size, unpackedSize, fileCount }) => ({ name, proposedVersion, tarball, integrity, shasum, size, unpackedSize, fileCount }));
if (JSON.stringify(evidence(first)) !== JSON.stringify(evidence(second))) throw new Error("checkout build residue changed canonical package evidence");
if (first.commit !== second.commit || first.lockfile.sha256 !== second.lockfile.sha256) throw new Error("canonical identity drifted");
NODE

set +e
node scripts/generate-prerelease-manifest.mjs --image-digest latest --output /tmp/agent-wechat-bad-manifest.json >/dev/null 2>&1
bad_digest=$?
node scripts/generate-prerelease-manifest.mjs --image-digest "sha256:$(printf 'A%.0s' {1..64})" --output /tmp/agent-wechat-bad-upper.json >/dev/null 2>&1
bad_upper=$?
node scripts/generate-prerelease-manifest.mjs --image-digest "$digest" --output "$first" >/dev/null 2>&1
existing=$?
set -e
rm -f /tmp/agent-wechat-bad-manifest.json /tmp/agent-wechat-bad-upper.json
test "$bad_digest" -ne 0 && test "$bad_upper" -ne 0 && test "$existing" -ne 0

echo "prerelease manifest is canonical and checkout-residue independent"
