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

# Documented sequential eval must not clone instance A into a new directory.
seq_b="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "$seq_b"' EXIT
eval "$("$GEN" "$seq_b")"
read_persisted "$a/device-identity.env"
id_a="$FILE_MID $FILE_HN $FILE_MAC"
read_persisted "$seq_b/device-identity.env"
id_b="$FILE_MID $FILE_HN $FILE_MAC"
test "$id_a" != "$id_b"
echo "device-identity: sequential eval does not clone into a second directory"

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

# Launch N first-run generators. Every process must succeed and emit the
# persisted winner. Optionally seed a stale lock file first.
run_contenders() {
  local dir="$1"
  local n="$2"
  local outs="$dir/outs"
  local i fail=0 got
  rm -rf "$outs"
  mkdir -p "$outs"
  for i in $(seq 1 "$n"); do
    (
      unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
      if ! "$GEN" "$dir" >"$outs/$i" 2>"$outs/$i.err"; then
        : >"$outs/$i.fail"
      fi
    ) &
  done
  wait
  test -f "$dir/device-identity.env"
  read_persisted "$dir/device-identity.env"
  persisted="$FILE_MID $FILE_HN $FILE_MAC"
  for i in $(seq 1 "$n"); do
    if [ -f "$outs/$i.fail" ] || [ ! -s "$outs/$i" ]; then
      echo "contender $i failed:" >&2
      cat "$outs/$i.err" >&2 || true
      fail=$((fail + 1))
      continue
    fi
    got="$(
      unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
      eval "$(cat "$outs/$i")"
      printf '%s %s %s' "$AGENT_WECHAT_MACHINE_ID" "$AGENT_WECHAT_HOSTNAME" "$AGENT_WECHAT_MAC"
    )"
    if [ "$got" != "$persisted" ]; then
      echo "contender $i emitted '$got' want '$persisted'" >&2
      fail=$((fail + 1))
    fi
  done
  test "$fail" -eq 0
  unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
  eval "$("$GEN" "$dir")"
  test "$AGENT_WECHAT_MACHINE_ID $AGENT_WECHAT_HOSTNAME $AGENT_WECHAT_MAC" = "$persisted"
}

dead_pid() {
  (sleep 30) &
  local pid=$!
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  printf '%s' "$pid"
}

# Concurrent first-run: every process must emit the single persisted winner.
c="$(mktemp -d)"
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
run_contenders "$c" 30
echo "device-identity: 30 concurrent first-runs emit the persisted winner"

# No-flock path: 5x100 first-runs, every caller succeeds.
export AGENT_WECHAT_IDENTITY_LOCK=file
round=1
while [ "$round" -le 5 ]; do
  d="$(mktemp -d)"
  run_contenders "$d" 100
  rm -rf "$d"
  round=$((round + 1))
done
echo "device-identity: 5x100 file-lock first-runs all succeed"

# Stale-lock recovery: dead-PID lock + 5x100 contenders, all succeed.
round=1
while [ "$round" -le 5 ]; do
  d="$(mktemp -d)"
  printf '%s.stale\n' "$(dead_pid)" >"$d/.device-identity.lock"
  run_contenders "$d" 100
  rm -rf "$d"
  round=$((round + 1))
done
unset AGENT_WECHAT_IDENTITY_LOCK
echo "device-identity: 5x100 stale file-lock recoveries all succeed"

lock_free_within() {
  local lock="$1"
  local seconds="$2"
  python3 -c '
import fcntl, os, sys, time
path, limit = sys.argv[1], float(sys.argv[2])
start = time.time()
while time.time() - start < limit:
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)
        raise SystemExit(0)
    except BlockingIOError:
        time.sleep(0.05)
raise SystemExit(1)
' "$lock" "$seconds"
}

run_promptly() {
  local dir="$1"
  python3 -c '
import subprocess, sys
subprocess.run([sys.argv[1], sys.argv[2]], check=True, timeout=3, stdout=subprocess.DEVNULL)
' "$GEN" "$dir"
}

# SIGKILL before acquisition: waiter must not leave a holder behind.
kdir="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "${envdir:-}" "$kdir"' EXIT
kready="$kdir/holder-ready"
python3 -c '
import fcntl, os, sys, time
path, ready = sys.argv[1], sys.argv[2]
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(ready, "w").write("ok\n")
time.sleep(30)
' "$kdir/.device-identity.lock" "$kready" &
holder=$!
while [ ! -f "$kready" ]; do sleep 0.01; done
AGENT_WECHAT_IDENTITY_LOCK=file "$GEN" "$kdir" >"$kdir/waiter.out" 2>"$kdir/waiter.err" &
waiter=$!
sleep 0.3
kill -9 "$waiter" 2>/dev/null || true
wait "$waiter" 2>/dev/null || true
if kill -0 "$waiter" 2>/dev/null; then
  echo "SIGKILL waiter is still alive" >&2
  kill -9 "$holder" 2>/dev/null || true
  exit 1
fi
kill -9 "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
lock_free_within "$kdir/.device-identity.lock" 2
run_promptly "$kdir"
echo "device-identity: SIGKILL before acquire leaves no stranded lock"

# SIGKILL after lock acquisition: helper-less owner dies, lock is released.
kdir2="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "${envdir:-}" "$kdir" "$kdir2"' EXIT
AGENT_WECHAT_IDENTITY_HOLD_MS=15000 AGENT_WECHAT_IDENTITY_LOCK=file \
  "$GEN" "$kdir2" >"$kdir2/out" 2>"$kdir2/err" &
held=$!
python3 -c '
import fcntl, os, sys, time
path = sys.argv[1]
start = time.time()
while time.time() - start < 5:
    try:
        fd = os.open(path, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.close(fd)
        except BlockingIOError:
            os.close(fd)
            raise SystemExit(0)
    except FileNotFoundError:
        pass
    time.sleep(0.05)
raise SystemExit("lock was never held")
' "$kdir2/.device-identity.lock"
kill -9 "$held" 2>/dev/null || true
wait "$held" 2>/dev/null || true
if kill -0 "$held" 2>/dev/null; then
  echo "SIGKILL holder is still alive" >&2
  exit 1
fi
lock_free_within "$kdir2/.device-identity.lock" 2
run_promptly "$kdir2"
echo "device-identity: SIGKILL after acquire releases the lock"

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

# Inherited exports are ignored unless AGENT_WECHAT_IDENTITY_FROM_ENV=1.
envdir="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "$envdir"' EXIT
AGENT_WECHAT_HOSTNAME="valid; touch $marker" "$GEN" "$envdir" >/dev/null
test ! -e "$marker"
test -f "$envdir/device-identity.env"

if AGENT_WECHAT_IDENTITY_FROM_ENV=1 AGENT_WECHAT_HOSTNAME="valid; touch $marker" \
  "$GEN" "$(mktemp -d)" >/dev/null 2>"$envdir/err"; then
  echo "semicolon hostname override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

if AGENT_WECHAT_IDENTITY_FROM_ENV=1 AGENT_WECHAT_MACHINE_ID='$(touch '"$marker"')' \
  "$GEN" "$(mktemp -d)" >/dev/null 2>"$envdir/err"; then
  echo "command-substitution machine-id override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

if AGENT_WECHAT_IDENTITY_FROM_ENV=1 AGENT_WECHAT_HOSTNAME=$'foo\nbar' \
  "$GEN" "$(mktemp -d)" >/dev/null 2>"$envdir/err"; then
  echo "newline hostname override should be rejected" >&2
  exit 1
fi
test ! -e "$marker"

python3 -c 'open("'"$envdir"'/device-identity.env","wb").write(b"AGENT_WECHAT_MACHINE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0\nAGENT_WECHAT_HOSTNAME=lenovo-pc-100\nAGENT_WECHAT_MAC=00:1b:21:00:00:01\n")'
if "$GEN" "$envdir" >/dev/null 2>"$envdir/err"; then
  echo "embedded NUL should be rejected" >&2
  exit 1
fi

echo "device-identity: malformed and injected values are rejected without executing"

# CLI JSON is imported into the canonical env file; conflicting files fail.
xdir="$(mktemp -d)"
trap 'rm -rf "$a" "$b" "$evil" "${c:-}" "${envdir:-}" "$kdir" "$kdir2" "$xdir"' EXIT
python3 - <<PY
import json
from pathlib import Path
p = Path("$xdir") / "device-identity.json"
p.write_text(json.dumps({
    "machineId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "hostname": "honor-pc-222",
    "mac": "00:1b:21:bb:bb:bb",
}) + "\n")
PY
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$xdir")"
test "$AGENT_WECHAT_MACHINE_ID" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
test "$AGENT_WECHAT_HOSTNAME" = "honor-pc-222"
test "$AGENT_WECHAT_MAC" = "00:1b:21:bb:bb:bb"
read_persisted "$xdir/device-identity.env"
test "$FILE_MID" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

ydir="$(mktemp -d)"
printf 'AGENT_WECHAT_MACHINE_ID=cccccccccccccccccccccccccccccccc\nAGENT_WECHAT_HOSTNAME=asus-pc-333\nAGENT_WECHAT_MAC=00:1b:21:cc:cc:cc\n' >"$ydir/device-identity.env"
python3 - <<PY
import json
from pathlib import Path
p = Path("$ydir") / "device-identity.json"
p.write_text(json.dumps({
    "machineId": "dddddddddddddddddddddddddddddddd",
    "hostname": "dell-pc-444",
    "mac": "00:1b:21:dd:dd:dd",
}) + "\n")
PY
if "$GEN" "$ydir" >/dev/null 2>"$ydir/err"; then
  echo "conflicting json/env should fail" >&2
  exit 1
fi
grep -Fq conflicting "$ydir/err"

# Compose -> CLI: env winner is reused by the CLI helper.
zdir="$(mktemp -d)"
unset AGENT_WECHAT_MACHINE_ID AGENT_WECHAT_HOSTNAME AGENT_WECHAT_MAC
eval "$("$GEN" "$zdir")"
cli_out="$(
  cd "$ROOT/packages/cli"
  node --experimental-strip-types -e 'import { ensureDeviceIdentity } from "./src/device-identity.ts"; const id = ensureDeviceIdentity(process.argv[1]); process.stdout.write(`${id.machineId} ${id.hostname} ${id.mac}`);' "$zdir"
)"
test "$cli_out" = "$AGENT_WECHAT_MACHINE_ID $AGENT_WECHAT_HOSTNAME $AGENT_WECHAT_MAC"

# Symlink identity path is rejected and does not write through the target.
sdir="$(mktemp -d)"
victim="$sdir/victim.env"
printf 'keep\n' >"$victim"
ln -s "$victim" "$sdir/device-identity.env"
if "$GEN" "$sdir" >/dev/null 2>"$sdir/err"; then
  echo "symlink env should be rejected" >&2
  exit 1
fi
test "$(cat "$victim")" = "keep"
grep -Fq symlink "$sdir/err"

echo "device-identity: JSON import, conflict, CLI reuse, and symlink rejection"
echo "device-identity: same dir stable, second dir differs"
