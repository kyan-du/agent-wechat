#!/usr/bin/env bash
# Persist one desktop identity per data dir and print shell assignments.
# Used by Compose before `docker compose up` so hostname/MAC are applied at
# create time (the container cannot change UTS hostname with only NET_ADMIN).
set -euo pipefail

DIR="${1:-${AGENT_WECHAT_IDENTITY_DIR:-$HOME/.config/agent-wechat}}"
mkdir -p "$DIR"
ENV_FILE="$DIR/device-identity.env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
fi

if [ -z "${AGENT_WECHAT_MACHINE_ID:-}" ] || [ "${#AGENT_WECHAT_MACHINE_ID}" -ne 32 ]; then
  if [ -r /proc/sys/kernel/random/uuid ]; then
    AGENT_WECHAT_MACHINE_ID="$(tr -d '-' </proc/sys/kernel/random/uuid | tr 'A-F' 'a-f')"
  else
    AGENT_WECHAT_MACHINE_ID="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  AGENT_WECHAT_MACHINE_ID="$(printf '%s' "$AGENT_WECHAT_MACHINE_ID" | tr -dc 'a-f0-9' | head -c 32)"
fi

derive_hostname() {
  local mid="$1"
  local prefixes=(lenovo-pc honor-pc xiaomi-pc asus-pc dell-pc hp-pc thinkpad)
  local idx=$(( 0x${mid:0:2} % ${#prefixes[@]} ))
  local num=$(( 0x${mid:2:4} % 900 + 100 ))
  printf '%s-%s' "${prefixes[$idx]}" "$num"
}

derive_mac() {
  local mid="$1"
  printf '00:1b:21:%s:%s:%s' "${mid:6:2}" "${mid:8:2}" "${mid:10:2}"
}

if [ -z "${AGENT_WECHAT_HOSTNAME:-}" ]; then
  AGENT_WECHAT_HOSTNAME="$(derive_hostname "$AGENT_WECHAT_MACHINE_ID")"
fi
if [ -z "${AGENT_WECHAT_MAC:-}" ]; then
  AGENT_WECHAT_MAC="$(derive_mac "$AGENT_WECHAT_MACHINE_ID")"
fi

cat >"$ENV_FILE" <<EOF
AGENT_WECHAT_MACHINE_ID=$AGENT_WECHAT_MACHINE_ID
AGENT_WECHAT_HOSTNAME=$AGENT_WECHAT_HOSTNAME
AGENT_WECHAT_MAC=$AGENT_WECHAT_MAC
EOF

# Also emit for `eval $(scripts/device-identity.sh)`
printf 'AGENT_WECHAT_MACHINE_ID=%s\n' "$AGENT_WECHAT_MACHINE_ID"
printf 'AGENT_WECHAT_HOSTNAME=%s\n' "$AGENT_WECHAT_HOSTNAME"
printf 'AGENT_WECHAT_MAC=%s\n' "$AGENT_WECHAT_MAC"
