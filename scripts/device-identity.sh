#!/usr/bin/env bash
# Persist one desktop identity per data dir and print shell assignments.
# Used by Compose before `docker compose up` so hostname/MAC are applied at
# create time (the container cannot change UTS hostname with only NET_ADMIN).
#
# First-run creation is serialized: contenders take a lock, re-read the
# persisted file, and only the first writer generates. Everyone then emits
# the single on-disk winner. The env file is parsed as data, never sourced.
set -euo pipefail

DIR="${1:-${AGENT_WECHAT_IDENTITY_DIR:-$HOME/.config/agent-wechat}}"
mkdir -p "$DIR"
ENV_FILE="$DIR/device-identity.env"
LOCK_FILE="$DIR/.device-identity.lock"
LOCK_PY=""
LOCK_READY=""

die() {
  echo "[identity] $*" >&2
  exit 1
}

valid_machine_id() {
  case "$1" in
    *$'\n'* | *$'\r'*) return 1 ;;
  esac
  [[ "$1" =~ ^[0-9a-f]{32}$ ]]
}

valid_hostname() {
  case "$1" in
    *$'\n'* | *$'\r'*) return 1 ;;
  esac
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 63 ] || return 1
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

valid_mac() {
  case "$1" in
    *$'\n'* | *$'\r'*) return 1 ;;
  esac
  [[ "$1" =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || return 1
  local first="${1%%:*}"
  local dec=$((16#$first))
  [ $((dec % 2)) -eq 0 ]
}

# Parse KEY=value records as data. Reject unknown/duplicate/malformed lines.
parse_identity_file() {
  local file="$1"
  local line value
  local mid="" hn="" mac=""
  local seen_mid=0 seen_hn=0 seen_mac=0

  if command -v python3 >/dev/null 2>&1; then
    if python3 -c 'import sys; sys.exit(0 if b"\0" in open(sys.argv[1],"rb").read() else 1)' "$file"; then
      die "NUL in $file"
    fi
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      AGENT_WECHAT_MACHINE_ID=*)
        [ "$seen_mid" -eq 0 ] || die "duplicate AGENT_WECHAT_MACHINE_ID in $file"
        value="${line#AGENT_WECHAT_MACHINE_ID=}"
        valid_machine_id "$value" || die "invalid AGENT_WECHAT_MACHINE_ID in $file"
        mid="$value"
        seen_mid=1
        ;;
      AGENT_WECHAT_HOSTNAME=*)
        [ "$seen_hn" -eq 0 ] || die "duplicate AGENT_WECHAT_HOSTNAME in $file"
        value="${line#AGENT_WECHAT_HOSTNAME=}"
        valid_hostname "$value" || die "invalid AGENT_WECHAT_HOSTNAME in $file"
        hn="$value"
        seen_hn=1
        ;;
      AGENT_WECHAT_MAC=*)
        [ "$seen_mac" -eq 0 ] || die "duplicate AGENT_WECHAT_MAC in $file"
        value="${line#AGENT_WECHAT_MAC=}"
        valid_mac "$value" || die "invalid AGENT_WECHAT_MAC in $file"
        mac="$value"
        seen_mac=1
        ;;
      *)
        die "unexpected line in $file"
        ;;
    esac
  done <"$file"

  [ "$seen_mid" -eq 1 ] && [ "$seen_hn" -eq 1 ] && [ "$seen_mac" -eq 1 ] ||
    die "incomplete identity in $file"

  AGENT_WECHAT_MACHINE_ID="$mid"
  AGENT_WECHAT_HOSTNAME="$hn"
  AGENT_WECHAT_MAC="$mac"
}

validate_override() {
  local name="$1"
  local value="$2"
  local checker="$3"
  if [ -n "$value" ] && ! "$checker" "$value"; then
    die "invalid $name override"
  fi
}

write_identity_atomic() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  chmod 0600 "$tmp"
  printf 'AGENT_WECHAT_MACHINE_ID=%s\n' "$AGENT_WECHAT_MACHINE_ID" >"$tmp"
  printf 'AGENT_WECHAT_HOSTNAME=%s\n' "$AGENT_WECHAT_HOSTNAME" >>"$tmp"
  printf 'AGENT_WECHAT_MAC=%s\n' "$AGENT_WECHAT_MAC" >>"$tmp"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; f=open(sys.argv[1],"ab"); os.fsync(f.fileno()); f.close()' "$tmp"
  fi
  mv -f "$tmp" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

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

release_lock() {
  if [ -n "$LOCK_PY" ]; then
    kill "$LOCK_PY" 2>/dev/null || true
    wait "$LOCK_PY" 2>/dev/null || true
    LOCK_PY=""
  fi
  if [ -n "$LOCK_READY" ]; then
    rm -f "$LOCK_READY"
    LOCK_READY=""
  fi
}

# Portable exclusive lock via fcntl. An orphaned lock file is just a
# handle; the next helper acquires it. No PID-based rm of a shared path.
acquire_fcntl_lock() {
  command -v python3 >/dev/null 2>&1 || die "python3 is required for the portable identity lock"
  LOCK_READY="$DIR/.device-identity.lock.ready.$$.$RANDOM"
  rm -f "$LOCK_READY"
  python3 -c '
import fcntl, os, signal, sys, time

def _exit(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, _exit)
signal.signal(signal.SIGINT, _exit)
fh = open(sys.argv[1], "a+")
fcntl.flock(fh, fcntl.LOCK_EX)
ready = sys.argv[2]
tmp = ready + ".tmp"
with open(tmp, "w") as out:
    out.write("ok\n")
os.replace(tmp, ready)
while True:
    time.sleep(3600)
' "$LOCK_FILE" "$LOCK_READY" &
  LOCK_PY=$!
  n=0
  while [ ! -f "$LOCK_READY" ]; do
    if ! kill -0 "$LOCK_PY" 2>/dev/null; then
      die "identity lock helper exited before acquiring"
    fi
    n=$((n + 1))
    if [ "$n" -ge 1000 ]; then
      die "timeout waiting for identity lock helper"
    fi
    sleep 0.01
  done
  rm -f "$LOCK_READY"
}

trap release_lock EXIT

if [ "${AGENT_WECHAT_IDENTITY_LOCK:-}" != "file" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock 9
else
  acquire_fcntl_lock
fi

if [ -f "$ENV_FILE" ]; then
  parse_identity_file "$ENV_FILE"
else
  validate_override AGENT_WECHAT_MACHINE_ID "${AGENT_WECHAT_MACHINE_ID:-}" valid_machine_id
  validate_override AGENT_WECHAT_HOSTNAME "${AGENT_WECHAT_HOSTNAME:-}" valid_hostname
  validate_override AGENT_WECHAT_MAC "${AGENT_WECHAT_MAC:-}" valid_mac

  if [ -z "${AGENT_WECHAT_MACHINE_ID:-}" ]; then
    if [ -r /proc/sys/kernel/random/uuid ]; then
      AGENT_WECHAT_MACHINE_ID="$(tr -d '-' </proc/sys/kernel/random/uuid | tr 'A-F' 'a-f')"
    else
      AGENT_WECHAT_MACHINE_ID="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    AGENT_WECHAT_MACHINE_ID="$(printf '%s' "$AGENT_WECHAT_MACHINE_ID" | tr -dc 'a-f0-9' | head -c 32)"
  fi
  valid_machine_id "$AGENT_WECHAT_MACHINE_ID" || die "generated machine-id is invalid"

  if [ -z "${AGENT_WECHAT_HOSTNAME:-}" ]; then
    AGENT_WECHAT_HOSTNAME="$(derive_hostname "$AGENT_WECHAT_MACHINE_ID")"
  fi
  if [ -z "${AGENT_WECHAT_MAC:-}" ]; then
    AGENT_WECHAT_MAC="$(derive_mac "$AGENT_WECHAT_MACHINE_ID")"
  fi
  valid_hostname "$AGENT_WECHAT_HOSTNAME" || die "generated hostname is invalid"
  valid_mac "$AGENT_WECHAT_MAC" || die "generated MAC is invalid"

  write_identity_atomic
  parse_identity_file "$ENV_FILE"
fi

# Emit shell-safe exports so `eval "$(./scripts/device-identity.sh)"` can
# populate Compose interpolation. The persisted file is KEY=value data.
printf 'export AGENT_WECHAT_MACHINE_ID=%q\n' "$AGENT_WECHAT_MACHINE_ID"
printf 'export AGENT_WECHAT_HOSTNAME=%q\n' "$AGENT_WECHAT_HOSTNAME"
printf 'export AGENT_WECHAT_MAC=%q\n' "$AGENT_WECHAT_MAC"
