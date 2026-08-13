#!/usr/bin/env bash
# Give this WeChat instance a unique, persistent desktop identity.
# Shared image machine-id is the device-farm signal that gets accounts
# kicked in a login loop (see WechatOnCloud / issue #7).
#
# Fail closed unless create-time machine-id, hostname, and MAC all match
# the live container. Do not overwrite a conflicting persisted machine-id.
set -euo pipefail

ID_DIR="${AGENT_WECHAT_IDENTITY_DIR:-/data/device-identity}"
mkdir -p "$ID_DIR"
ID_FILE="$ID_DIR/machine-id"
HOST_FILE="$ID_DIR/hostname"
NET_DIR="${AGENT_WECHAT_NET_DIR:-/sys/class/net}"

die() {
  echo "[identity] ERROR: $*" >&2
  exit 1
}

valid_machine_id() {
  case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac
  [ "${#1}" -eq 32 ] || return 1
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{32}$'
}

valid_hostname() {
  case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 63 ] || return 1
  printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
}

valid_mac() {
  case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$' || return 1
  first="${1%%:*}"
  dec=$((16#$first))
  [ $((dec % 2)) -eq 0 ]
}

[ -n "${AGENT_WECHAT_MACHINE_ID:-}" ] || die "AGENT_WECHAT_MACHINE_ID is required"
[ -n "${AGENT_WECHAT_HOSTNAME:-}" ] || die "AGENT_WECHAT_HOSTNAME is required"
[ -n "${AGENT_WECHAT_MAC:-}" ] || die "AGENT_WECHAT_MAC is required"
valid_machine_id "$AGENT_WECHAT_MACHINE_ID" || die "invalid AGENT_WECHAT_MACHINE_ID"
valid_hostname "$AGENT_WECHAT_HOSTNAME" || die "invalid AGENT_WECHAT_HOSTNAME"
valid_mac "$AGENT_WECHAT_MAC" || die "invalid AGENT_WECHAT_MAC"

MID="$AGENT_WECHAT_MACHINE_ID"
HN="$AGENT_WECHAT_HOSTNAME"
MAC="$AGENT_WECHAT_MAC"

if [ -s "$ID_FILE" ]; then
  EXISTING="$(tr -dc 'a-f0-9' < "$ID_FILE" | head -c 32)"
  if [ "$EXISTING" != "$MID" ]; then
    die "persisted machine-id '${EXISTING}' does not match requested '$MID'"
  fi
fi

read_live_mac() {
  local ifc addr
  for ifc in eth0 ens3 enp0s3; do
    if [ -r "$NET_DIR/$ifc/address" ]; then
      tr 'A-F' 'a-f' < "$NET_DIR/$ifc/address" | tr -d ' \n'
      return 0
    fi
  done
  for addr in "$NET_DIR"/*/address; do
    [ -r "$addr" ] || continue
    case "$addr" in */lo/address) continue ;; esac
    tr 'A-F' 'a-f' < "$addr" | tr -d ' \n'
    return 0
  done
  return 1
}

ACTUAL_HN="$(hostname 2>/dev/null || true)"
if [ "$ACTUAL_HN" != "$HN" ]; then
  if command -v hostname >/dev/null 2>&1; then
    hostname "$HN" 2>/dev/null || true
  fi
  ACTUAL_HN="$(hostname 2>/dev/null || true)"
fi
[ "$ACTUAL_HN" = "$HN" ] || die "hostname is '${ACTUAL_HN:-unknown}', want '$HN'. Pass hostname/MAC at container create."

ACTUAL_MAC="$(read_live_mac || true)"
[ -n "$ACTUAL_MAC" ] || die "could not read container MAC from $NET_DIR"
[ "$ACTUAL_MAC" = "$MAC" ] || die "MAC is '$ACTUAL_MAC', want '$MAC'. Pass hostname/MAC at container create."

printf '%s\n' "$MID" > "$ID_FILE"
printf '%s\n' "$HN" > "$HOST_FILE"
{ printf '%s\n' "$MID" > /etc/machine-id; } 2>/dev/null || true
mkdir -p /var/lib/dbus 2>/dev/null || true
{ printf '%s\n' "$MID" > /var/lib/dbus/machine-id; } 2>/dev/null || true

rm -f /.dockerenv 2>/dev/null || true

if [ "${AGENT_WECHAT_SPOOF_OS:-1}" = "1" ]; then
  if ! cat > /etc/os-release 2>/dev/null <<'OSEOF'
PRETTY_NAME="deepin 23"
NAME="deepin"
VERSION_ID="23"
VERSION="23"
VERSION_CODENAME=beige
ID=deepin
ID_LIKE=debian
HOME_URL="https://www.deepin.org/"
BUG_REPORT_URL="https://bbs.deepin.org/"
OSEOF
  then
    :
  fi
fi

DOCKERENV="absent"
[ -e /.dockerenv ] && DOCKERENV="present"

echo "[identity] machine-id=${MID:0:8}… hostname=${HN} mac=${MAC} dockerenv=${DOCKERENV} os_spoof=${AGENT_WECHAT_SPOOF_OS:-1}"
