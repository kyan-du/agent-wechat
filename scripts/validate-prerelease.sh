#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [ "${CI:-}" = true ] && [ -n "$(git status --porcelain --untracked-files=all | grep -Ev '^\?\? \.pnpm-store/' || true)" ]; then
  echo "clean checkout required" >&2
  exit 1
fi

node scripts/validate-prerelease-contract.mjs
pnpm install --frozen-lockfile
pnpm typecheck
pnpm -r --if-present test
pnpm build
node scripts/validate-release-boundary.mjs --require-rendered
for package_dir in packages/cli packages/openclaw-extension packages/wechaty-puppet; do
  (
    cd "$package_dir"
    report=$(npm pack --dry-run --json --ignore-scripts)
    node -e '
      const report = JSON.parse(process.argv[1]);
      if (report.length !== 1 || !report[0].filename || !report[0].integrity || !report[0].files?.length) {
        throw new Error("incomplete npm pack dry-run evidence");
      }
      console.log(`${report[0].name}@${report[0].version}: ${report[0].filename} ${report[0].integrity}`);
    ' "$report"
  )
done

unexpected=$(git status --porcelain --untracked-files=all | grep -Ev '^(\?\?| M) (packages/.*/dist/|docs/dist/|\.pnpm-store/)' || true)
test -z "$unexpected" || { printf '%s\n' "$unexpected" >&2; exit 1; }

echo "P1-B1 validation completed without publication side effects"
