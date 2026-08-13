#!/usr/bin/env bash
# Give this WeChat instance a unique, persistent desktop identity.
# Shared image machine-id is the device-farm signal that gets accounts
# kicked in a login loop (see WechatOnCloud / issue #7).
set -euo pipefail

ID_DIR="${AGENT_WECHAT_IDENTITY_DIR:-/data/device-identity}"
mkdir -p "$ID_DIR"

ID_FILE="$ID_DIR/machine-id"
HOST_FILE="$ID_DIR/hostname"

# 32 lowercase hex, systemd machine-id format.
load_or_create_machine_id() {
  if [ -n "${AGENT_WECHAT_MACHINE_ID:-}" ]; then
    printf '%s\n' "$(printf '%s' "$AGENT_WECHAT_MACHINE_ID" | tr -dc 'a-fA-F0-9' | tr 'A-F' 'a-f' | head -c 32)"
    return
  fi
  if [ -s "$ID_FILE" ]; then
    tr -dc 'a-f0-9' < "$ID_FILE" | head -c 32
    return
  fi
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '-' < /proc/sys/kernel/random/uuid | tr 'A-F' 'a-f'
  else
    head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

MID="$(load_or_create_machine_id)"
if [ "${#MID}" -ne 32 ]; then
  MID="$(tr -d '-' < /proc/sys/kernel/random/uuid | tr 'A-F' 'a-f' | head -c 32)"
fi
printf '%s\n' "$MID" > "$ID_FILE"

printf '%s\n' "$MID" > /etc/machine-id 2>/dev/null || true
mkdir -p /var/lib/dbus
printf '%s\n' "$MID" > /var/lib/dbus/machine-id 2>/dev/null || true

# Drop the most obvious container marker.
rm -f /.dockerenv 2>/dev/null || true

# Hostname: personal-desktop style, stable per instance.
if [ -n "${AGENT_WECHAT_HOSTNAME:-}" ]; then
  HN="$AGENT_WECHAT_HOSTNAME"
elif [ -s "$HOST_FILE" ]; then
  HN="$(tr -d '\n' < "$HOST_FILE")"
else
  PREFIXES=(lenovo-pc honor-pc xiaomi-pc asus-pc dell-pc hp-pc thinkpad)
  idx=$(( 0x${MID:0:2} % ${#PREFIXES[@]} ))
  num=$(( 0x${MID:2:4} % 900 + 100 ))
  HN="${PREFIXES[$idx]}-${num}"
fi
printf '%s\n' "$HN" > "$HOST_FILE"
ACTUAL_HN="$(hostname 2>/dev/null || true)"
if [ "$ACTUAL_HN" != "$HN" ]; then
  if command -v hostname >/dev/null 2>&1; then
    hostname "$HN" 2>/dev/null || true
  fi
  ACTUAL_HN="$(hostname 2>/dev/null || true)"
fi
if [ "$ACTUAL_HN" != "$HN" ]; then
  echo "[identity] ERROR: hostname is '${ACTUAL_HN:-unknown}', want '$HN'." >&2
  echo "[identity] Pass hostname/MAC at container create (wx up or scripts/device-identity.sh)." >&2
  exit 1
fi

# os-release: WeChat Linux officially supports deepin. Deepin is Debian-based,
# matching this image's userspace. Set AGENT_WECHAT_SPOOF_OS=0 to skip.
if [ "${AGENT_WECHAT_SPOOF_OS:-1}" = "1" ]; then
  cat > /etc/os-release <<'OSEOF'
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
fi

DOCKERENV="absent"
[ -e /.dockerenv ] && DOCKERENV="present"

echo "[identity] machine-id=${MID:0:8}… hostname=${HN} dockerenv=${DOCKERENV} os_spoof=${AGENT_WECHAT_SPOOF_OS:-1}"
