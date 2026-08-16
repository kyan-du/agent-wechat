#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESET="$ROOT/docker/reset-device-identity.sh"
IDENTITY="$ROOT/docker/identity.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/data/device-identity" "$work/net/eth0" "$work/bin"
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$work/data/device-identity/machine-id"
printf '%s\n' old-host > "$work/data/device-identity/hostname"
printf 'agent-db-must-survive\n' > "$work/data/agent.db"
printf 'token-must-survive\n' > "$work/data/auth-token"
printf 'wechat-cache-is-separate\n' > "$work/wechat-home"

AGENT_WECHAT_RESET_TESTING=1 AGENT_WECHAT_IDENTITY_DIR="$work/data/device-identity" sh "$RESET"
test ! -e "$work/data/device-identity/machine-id"
test ! -e "$work/data/device-identity/hostname"
test "$(cat "$work/data/agent.db")" = agent-db-must-survive
test "$(cat "$work/data/auth-token")" = token-must-survive
test "$(cat "$work/wechat-home")" = wechat-cache-is-separate

cat > "$work/bin/hostname" <<'EOF'
#!/bin/sh
cat "$FAKE_HN_FILE"
EOF
chmod +x "$work/bin/hostname"
printf '%s\n' fresh-host > "$work/hostname"
printf '%s\n' '00:1b:21:00:00:02' > "$work/net/eth0/address"
env -i \
  PATH="$work/bin:/usr/bin:/bin" \
  HOME="$work" \
  FAKE_HN_FILE="$work/hostname" \
  AGENT_WECHAT_IDENTITY_DIR="$work/data/device-identity" \
  AGENT_WECHAT_NET_DIR="$work/net" \
  AGENT_WECHAT_SPOOF_OS=0 \
  AGENT_WECHAT_MACHINE_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  AGENT_WECHAT_HOSTNAME=fresh-host \
  AGENT_WECHAT_MAC=00:1b:21:00:00:02 \
  bash "$IDENTITY" >/dev/null

test "$(cat "$work/data/device-identity/machine-id")" = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
test "$(cat "$work/data/device-identity/hostname")" = fresh-host
test "$(cat "$work/data/agent.db")" = agent-db-must-survive
test "$(cat "$work/data/auth-token")" = token-must-survive

victim="$work/victim"
printf 'do-not-delete\n' > "$victim"
rm -rf "$work/data/device-identity"
ln -s "$victim" "$work/data/device-identity"
set +e
AGENT_WECHAT_RESET_TESTING=1 AGENT_WECHAT_IDENTITY_DIR="$work/data/device-identity" sh "$RESET" >/dev/null 2>"$work/symlink.err"
code=$?
set -e
test "$code" -ne 0
test "$(cat "$victim")" = do-not-delete

echo 'auth reset identity: exact container scope clears both identity copies and preserves DB/token'
