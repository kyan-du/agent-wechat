#!/usr/bin/env bash
# Ownership guard must reject PID 1-adopted orphans.
# Re-exec as PID 1 via user/pid namespace (or already being PID 1).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/docker/supervise-agent-server.sh"
test -f "$LIB"

if [ "$$" -ne 1 ]; then
  if unshare --user --pid --fork --mount-proc --map-root-user true >/dev/null 2>&1; then
    exec unshare --user --pid --fork --mount-proc --map-root-user bash "$0"
  fi
  echo "FAIL: cannot become PID 1 to run ownership regression" >&2
  exit 1
fi

echo "pid1-ownership: running as pid $$"
# shellcheck disable=SC1090
. "$LIB"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"; kill $(jobs -p) 2>/dev/null || true' EXIT

# Orphan adopted by PID 1.
FOREIGN=$(sh -c 'sleep 30 >/dev/null 2>&1 & echo $!')
sleep 0.1
kill -0 "$FOREIGN" 2>/dev/null || fail "foreign orphan not running"
if [ -r "/proc/$FOREIGN/stat" ]; then
  fppid=$(_supervise_stat_field "$FOREIGN" 2)
else
  fppid=$(ps -o ppid= -p "$FOREIGN" 2>/dev/null | tr -d ' ')
fi
echo "foreign pid=$FOREIGN ppid=$fppid supervisor=$$"

SERVER_PID="$FOREIGN"
SERVER_START=""
SERVER_PGID=""
if _supervise_owned_child; then
  fail "PID 1 adopted orphan accepted without recorded starttime"
fi

# Simulate the old PPID==$$ bug: orphan reparented to us, but not our launch.
if [ "$fppid" = "$$" ]; then
  SERVER_START="wrong"
  if _supervise_owned_child; then
    fail "PID 1 adopted orphan accepted with mismatched starttime"
  fi
fi

# A real launched child is owned.
cat >"$SANDBOX/child" <<'EOF'
#!/bin/sh
while true; do sleep 30; done
EOF
chmod +x "$SANDBOX/child"
_supervise_start "$SANDBOX/child"
_supervise_owned_child || fail "launched child not owned (pid=$SERVER_PID start=$SERVER_START)"
owned="$SERVER_PID"

# Point SERVER_PID at the orphan while keeping the launched starttime.
SERVER_PID="$FOREIGN"
if _supervise_owned_child; then
  fail "orphan accepted when pid swapped but starttime kept"
fi

# Restore and confirm the real child is still the only owned process.
SERVER_PID="$owned"
_supervise_owned_child || fail "launched child lost ownership after swap test"
kill -KILL "$owned" 2>/dev/null || true
wait "$owned" 2>/dev/null || true
kill -KILL "$FOREIGN" 2>/dev/null || true
wait "$FOREIGN" 2>/dev/null || true
_supervise_clear_child

echo "ok: PID 1 ownership rejects adopted orphans and accepts launched child"
