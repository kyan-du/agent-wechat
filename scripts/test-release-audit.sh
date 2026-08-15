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
