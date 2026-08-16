#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd); cd "$root"
pnpm --filter @kyan-du/agent-wechat-shared build
pnpm --filter @kyan-du/agent-wechat-cli build
pnpm --filter @kyan-du/agent-wechat-openclaw build
pnpm --filter @kyan-du/agent-wechat-wechaty-puppet build
./scripts/audit-release.sh
./scripts/audit-release.sh
mv packages/cli/dist packages/cli/dist.audit-test
trap 'mv packages/cli/dist.audit-test packages/cli/dist 2>/dev/null || true' EXIT
if ./scripts/audit-release.sh >/dev/null 2>&1; then echo 'audit accepted missing build output' >&2; exit 1; fi
mv packages/cli/dist.audit-test packages/cli/dist; trap - EXIT
./scripts/audit-release.sh

# Exercise every sensitive-name rule directly, then retain one real npm-pack
# integration probe per public package. This preserves rule and package coverage
# without repeating the full workspace pack audit for every filename fixture.
node scripts/release-audit.mjs --test-forbidden-paths
probe_npm_forbidden() {
  local package_dir=$1 path=dist/mysecret.txt
  printf 'negative probe\n' > "$package_dir/$path"
  if node scripts/release-audit.mjs --write >/dev/null 2>&1; then
    echo "npm audit accepted forbidden packed path: $package_dir/$path" >&2; exit 1
  fi
  rm -f "$package_dir/$path"
}
for package_dir in packages/cli packages/openclaw-extension packages/wechaty-puppet; do
  for path in \
    dist/mysecret.txt dist/mycredential.txt dist/mytoken.txt \
    dist/.env.local dist/myenvironment.txt dist/my-private-key.txt \
    dist/my-api-key.txt dist/mycert.txt dist/client.crt; do
    probe_npm_forbidden "$package_dir" "$path"
  done
done
node scripts/release-audit.mjs --write
git diff --exit-code -- docs/release-audit/npm-materials.json

# Docker context positive and negative regressions.
node scripts/validate-docker-context.mjs
probe_forbidden() {
  local path=$1
  mkdir -p "$(dirname "docker/$path")"
  printf 'negative probe\n' > "docker/$path"
  printf '!%s\n' "$path" >> docker/.dockerignore
  if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then
    echo "Docker audit accepted forbidden context path: $path" >&2; exit 1
  fi
  sed -i.bak '$d' docker/.dockerignore && rm docker/.dockerignore.bak
  rm -f "docker/$path"
}
for path in \
  tools/mycredential.txt tools/mysecret.txt tools/mytoken.txt \
  mysecret-dir/probe.txt mycredential-dir/probe.txt mytoken-dir/probe.txt \
  dist/mysecret.txt dist/mycredential.txt dist/mytoken.txt dist/.env.local \
  arbitrary.deb arbitrary.log cache/probe.txt nested/cache/probe.txt \
  state.db-journal state.sqlite-wal .DS_Store agent-server-rust/target/probe.txt; do
  probe_forbidden "$path"
done
rmdir docker/cache docker/nested/cache docker/nested \
  docker/mysecret-dir docker/mycredential-dir docker/mytoken-dir docker/dist \
  docker/agent-server-rust/target docker/agent-server-rust 2>/dev/null || true

# Required sources must be real regular files contained by the context. Wrapper
# commands (everything except imported .py modules) must already be executable.
tmp_tool=docker/tools/screenshot.audit-test
mv docker/tools/screenshot "$tmp_tool"
trap 'rm -f docker/tools/screenshot; mv "$tmp_tool" docker/tools/screenshot 2>/dev/null || true' EXIT
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted missing production tool' >&2; exit 1; fi
ln -s screenshot.audit-test docker/tools/screenshot
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted symlinked production tool' >&2; exit 1; fi
rm docker/tools/screenshot
ln -s /etc/passwd docker/tools/screenshot
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted context escape' >&2; exit 1; fi
rm docker/tools/screenshot
mkdir docker/tools/screenshot
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted non-regular production tool' >&2; exit 1; fi
rmdir docker/tools/screenshot
cp "$tmp_tool" docker/tools/screenshot
chmod a-x docker/tools/screenshot
if node scripts/validate-docker-context.mjs >/dev/null 2>&1; then echo 'Docker audit accepted non-executable production tool' >&2; exit 1; fi
rm docker/tools/screenshot
mv "$tmp_tool" docker/tools/screenshot; trap - EXIT
node scripts/validate-docker-context.mjs

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
