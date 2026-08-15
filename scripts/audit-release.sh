#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
node scripts/validate-docker-context.mjs
node scripts/release-audit.mjs "$@"
