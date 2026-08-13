#!/usr/bin/env bash
# Same identity dir is stable; a second dir differs.
# Documented `eval "$(./scripts/device-identity.sh)"` must export for Compose.
# Persisted state is data, not sourced shell.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/scripts/device-identity.sh"
chmod +x "$GEN"

read_persisted() {
  local file="$1"
  local line
  FILE_MID="" FILE_HN="" FILE_MAC=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      AGENT_WECHAT_MACHINE_ID=*) FILE_MID="${line#AGENT_WECHAT_MACHINE_ID=}" ;;
      AGENT_WECHAT_HOSTNAME=*) FILE_HN="${line#AGENT_WECHAT_HOSTNAME=}" ;;
      AGENT_WECHAT_MAC=*) FILE_MAC="${line#AGENT_WECHAT_MAC=}" ;;
      *) echo "test: unexpected persisted line: $line" >&2; return 1 ;;
    esac
  done <"$file"
  [ -n "$FILE_MID" ] && [ -n "$FILE_HN" ] && [ -n "$FILE_MAC" ]
}

file_mode() {
  python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$1"
}

a="$(mktemp -d)"
b="$(mktemp -d)"
evil="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}"' EXIT

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

test "$(file_mode "$a/device-identity.env")" = "0o600"

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

# Concurrent first-run: every process must emit the single persisted winner.
c="$(mktemp -d)"
outs="$c/outs"
mkdir -p "$outs"
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
for i in $(seq 1 30); do
  (
    unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
    "$GEN" "$c" >"$outs/$i"
  ) &
done
wait
test -f "$c/device-identity.env"
read_persisted "$c/device-identity.env"
persisted="$FILE_MID $FILE_HN $FILE_MAC"
count=0
for i in $(seq 1 30); do
  got="$(
    unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
    eval "$(cat "$outs/$i")"
    printf '%s %s %s' "$AGENT_WECHAT_MACHINE_ID" "$AGENT_WECHAT_HOSTNAME" "$AGENT_WECHAT_MAC"
  )"
  test "$got" = "$persisted"
  count=$((count + 1))
done
test "$count" -eq 30
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$c")"
test "$AGENT_WECHAT_MACHINE_ID $AGENT_WECHAT_HOSTNAME $AGENT_WECHAT_MAC" = "$persisted"
echo "device-identity: 30 concurrent first-runs emit the persisted winner"

# Injection / malformed persisted files must be rejected and must not execute.
marker="$evil/pwned"
printf 'AGENT_WECHAT_MACHINE_ID=$(touch %s)\nAGENT_WECHAT_HOSTNAME=lenovo-pc-100\nAGENT_WECHAT_MAC=00:1b:21:00:00:01\n' "$marker" >"$evil/device-identity.env"
if "$GEN" "$evil" >/dev/null 2>"$evil/err"; then
  echo "command-substitution machine-id should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

printf 'printf MALFORMED_EXECUTED >&2\n' >"$evil/device-identity.env"
if out="$("$GEN" "$evil" 2>&1)"; then
  echo "executable persisted line should be rejected" >&2
  exit 1
else
  printf '%s' "$out" | grep -q MALFORMED_EXECUTED && {
    echo "malformed persisted file executed" >&2
    exit 1
  }
fi

printf 'AGENT_WECHAT_MACHINE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAGENT_WECHAT_HOSTNAME=valid; touch %s\nAGENT_WECHAT_MAC=00:1b:21:00:00:01\n' "$marker" >"$evil/device-identity.env"
if "$GEN" "$evil" >/dev/null 2>"$evil/err"; then
  echo "semicolon hostname should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

printf 'AGENT_WECHAT_MACHINE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAGENT_WECHAT_HOSTNAME=lenovo-pc-100\nAGENT_WECHAT_MAC=00:1b:21:00:00:01\nextra=1\n' >"$evil/device-identity.env"
"$GEN" "$evil" >/dev/null 2>"$evil/err" && {
  echo "unknown persisted key should be rejected" >&2
  exit 1
}

# Environment overrides are validated the same way and never executed.
envdir="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "$envdir"' EXIT
if AGENT_WECHAT_HOSTNAME="valid; touch $marker" "$GEN" "$envdir" >/dev/null 2>"$envdir/err"; then
  echo "semicolon hostname override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"
test ! -f "$envdir/device-identity.env"

if AGENT_WECHAT_MACHINE_ID='$(touch '"$marker"')' "$GEN" "$envdir" >/dev/null 2>"$envdir/err"; then
  echo "command-substitution machine-id override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

if AGENT_WECHAT_HOSTNAME=$'foo\nbar' "$GEN" "$envdir" >/dev/null 2>"$envdir/err"; then
  echo "newline hostname override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"
test ! -f "$envdir/device-identity.env"

echo "device-identity: malformed and injected values are rejected without executing"
echo "device-identity: same dir stable, second dir differs"
