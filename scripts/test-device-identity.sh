#!/usr/bin/env bash
# Same identity dir is stable; a second dir differs.
# Documented `eval "$(./scripts/device-identity.sh)"` must export for Compose.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/scripts/device-identity.sh"
chmod +x "$GEN"

a="$(mktemp -d)"
b="$(mktemp -d)"
trap 'rm -rf "$a" "$b"' EXIT

eval "$("$GEN" "$a")"
id1="$AGENT_WECHAT_MACHINE_ID"
hn1="$AGENT_WECHAT_HOSTNAME"
mac1="$AGENT_WECHAT_MAC"

# Child shells only see exported assignments. This is the Compose contract.
bash -c 'test -n "$AGENT_WECHAT_MACHINE_ID" && test -n "$AGENT_WECHAT_HOSTNAME" && test -n "$AGENT_WECHAT_MAC"'

unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$a")"
test "$AGENT_WECHAT_MACHINE_ID" = "$id1"
test "$AGENT_WECHAT_HOSTNAME" = "$hn1"
test "$AGENT_WECHAT_MAC" = "$mac1"

unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$b")"
test "$AGENT_WECHAT_MACHINE_ID" != "$id1"
test "$AGENT_WECHAT_HOSTNAME" != "$hn1" || test "$AGENT_WECHAT_MAC" != "$mac1"

# Documented command + Compose interpolation. Prefer the real renderer.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
  eval "$("$GEN" "$a")"
  cfg="$(docker compose -f "$ROOT/docker-compose.yml" --project-directory "$ROOT" config)"
  printf '%s\n' "$cfg" | grep -Fq "$AGENT_WECHAT_HOSTNAME"
  printf '%s\n' "$cfg" | grep -Fq "$AGENT_WECHAT_MAC"
  printf '%s\n' "$cfg" | grep -Fq "$AGENT_WECHAT_MACHINE_ID"
  echo "device-identity: eval exports; docker compose config interpolates"
else
  python3 - <<'PY'
import os
for key in ("AGENT_WECHAT_MACHINE_ID", "AGENT_WECHAT_HOSTNAME", "AGENT_WECHAT_MAC"):
    assert os.environ.get(key), key
print("device-identity: eval exports (docker compose not available)")
PY
fi

echo "device-identity: same dir stable, second dir differs"
