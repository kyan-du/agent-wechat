#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
pnpm --filter @agent-wechat/shared build
pnpm --filter @agent-wechat/cli build
pnpm --filter @agent-wechat/wechat build
pnpm --filter @agent-wechat/wechaty-puppet build
./scripts/audit-release.sh
./scripts/audit-release.sh
mv packages/cli/dist packages/cli/dist.audit-test
trap 'mv packages/cli/dist.audit-test packages/cli/dist 2>/dev/null || true' EXIT
if ./scripts/audit-release.sh >/dev/null 2>&1; then echo 'audit accepted missing build output' >&2; exit 1; fi
mv packages/cli/dist.audit-test packages/cli/dist; trap - EXIT
./scripts/audit-release.sh

# Docker context positive and negative regressions.
node scripts/validate-docker-context.mjs
tmp_tool=docker/tools/screenshot.audit-test
mv docker/tools/screenshot "$tmp_tool"
trap 'mv "$tmp_tool" docker/tools/screenshot 2>/dev/null || true' EXIT
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted missing production tool' >&2; exit 1; fi
mv "$tmp_tool" docker/tools/screenshot; trap - EXIT

tmp_secret=docker/tools/secret.audit-test.pem
printf 'negative probe\n' > "$tmp_secret"
trap 'rm -f "$tmp_secret"' EXIT
node scripts/validate-docker-context.mjs
printf '!tools/secret.audit-test.pem\n' >> docker/.dockerignore
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted forbidden secret in context' >&2; exit 1; fi
sed -i.bak '$d' docker/.dockerignore && rm docker/.dockerignore.bak
rm "$tmp_secret"; trap - EXIT

# The workflow clean-tree idiom must accept empty filtered output and reject dirt.
tmp_repo=$(mktemp -d)
trap 'rm -rf "$tmp_repo"' EXIT
git -C "$tmp_repo" init -q
git -C "$tmp_repo" config user.email audit@example.invalid
git -C "$tmp_repo" config user.name audit
printf 'tracked\n' > "$tmp_repo/tracked"
git -C "$tmp_repo" add tracked && git -C "$tmp_repo" commit -qm init
clean_tree=$(git -C "$tmp_repo" status --porcelain --untracked-files=all | grep -Ev '^(\?\?| M) (packages/.*/dist/|docs/dist/)' || true)
test -z "$clean_tree"
printf 'dirty\n' > "$tmp_repo/dirty"
dirty_tree=$(git -C "$tmp_repo" status --porcelain --untracked-files=all | grep -Ev '^(\?\?| M) (packages/.*/dist/|docs/dist/)' || true)
if test -z "$dirty_tree"; then echo 'clean-tree gate accepted dirty tree' >&2; exit 1; fi
rm -rf "$tmp_repo"; trap - EXIT
