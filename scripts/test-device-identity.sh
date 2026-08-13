#!/usr/bin/env bash
# Same identity dir is stable; a second dir differs.
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

unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$a")"
test "$AGENT_WECHAT_MACHINE_ID" = "$id1"
test "$AGENT_WECHAT_HOSTNAME" = "$hn1"
test "$AGENT_WECHAT_MAC" = "$mac1"

unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$b")"
test "$AGENT_WECHAT_MACHINE_ID" != "$id1"
test "$AGENT_WECHAT_HOSTNAME" != "$hn1" || test "$AGENT_WECHAT_MAC" != "$mac1"

echo "device-identity: same dir stable, second dir differs"
