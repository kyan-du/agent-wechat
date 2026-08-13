#!/usr/bin/env bash
# Persist one desktop identity per data dir and print shell assignments.
# Used by Compose before `docker compose up` so hostname/MAC are applied at
# create time (the container cannot change UTS hostname with only NET_ADMIN).
#
# First-run creation is serialized: contenders take a lock, re-read the
# persisted file, and only the first writer generates. Everyone then emits
# the single on-disk winner.
set -euo pipefail

DIR="${1:-${AGENT_WECHAT_IDENTITY_DIR:-$HOME/.config/agent-wechat}}"
mkdir -p "$DIR"
ENV_FILE="$DIR/device-identity.env"
LOCK_FILE="$DIR/.device-identity.lock"
LOCK_DIR="$DIR/.device-identity.lockdir"
IDENTITY_LOCKDIR=""

release_lock() {
  if [ -n "${IDENTITY_LOCKDIR:-}" ]; then
    rmdir "$IDENTITY_LOCKDIR" 2>/dev/null || true
    IDENTITY_LOCKDIR=""
  fi
}
trap release_lock EXIT

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock 9
else
  n=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -ge 200 ]; then
      echo "[identity] timeout acquiring $LOCK_DIR" >&2
      exit 1
    fi
    sleep 0.05
  done
  IDENTITY_LOCKDIR="$LOCK_DIR"
fi

# File is the source of truth once it exists. Re-read under the lock so a
# later contender emits the winner instead of its own candidate.
if [ -f "$ENV_FILE" ]; then
  unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
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

if [ -z "${AGENT_WECHAT_MACHINE_ID:-}" ] || [ "${#AGENT_WECHAT_MACHINE_ID}" -ne 32 ]; then
  if [ -r /proc/sys/kernel/random/uuid ]; then
    AGENT_WECHAT_MACHINE_ID="$(tr -d '-' </proc/sys/kernel/random/uuid | tr 'A-F' 'a-f')"
  else
    AGENT_WECHAT_MACHINE_ID="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  AGENT_WECHAT_MACHINE_ID="$(printf '%s' "$AGENT_WECHAT_MACHINE_ID" | tr -dc 'a-f0-9' | head -c 32)"
fi

if [ -z "${AGENT_WECHAT_HOSTNAME:-}" ]; then
  AGENT_WECHAT_HOSTNAME="$(derive_hostname "$AGENT_WECHAT_MACHINE_ID")"
fi
if [ -z "${AGENT_WECHAT_MAC:-}" ]; then
  AGENT_WECHAT_MAC="$(derive_mac "$AGENT_WECHAT_MACHINE_ID")"
fi

tmp="$(mktemp "$ENV_FILE.XXXXXX")"
cat >"$tmp" <<EOF
AGENT_WECHAT_MACHINE_ID=$AGENT_WECHAT_MACHINE_ID
AGENT_WECHAT_HOSTNAME=$AGENT_WECHAT_HOSTNAME
AGENT_WECHAT_MAC=$AGENT_WECHAT_MAC
EOF
mv -f "$tmp" "$ENV_FILE"

# Emit exactly what is on disk, not a pre-lock candidate.
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
# shellcheck disable=SC1090
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a

# Emit exports so `eval "$(./scripts/device-identity.sh)"` populates the
# environment Compose interpolation reads. The persisted file stays KEY=value
# for `set -a; . file` / `--env-file`.
printf 'export AGENT_WECHAT_MACHINE_ID=%s\n' "$AGENT_WECHAT_MACHINE_ID"
printf 'export AGENT_WECHAT_HOSTNAME=%s\n' "$AGENT_WECHAT_HOSTNAME"
printf 'export AGENT_WECHAT_MAC=%s\n' "$AGENT_WECHAT_MAC"
