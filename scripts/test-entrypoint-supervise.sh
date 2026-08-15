#!/usr/bin/env bash
# Deterministic lifecycle tests for docker/supervise-agent-server.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/docker/supervise-agent-server.sh"
test -f "$LIB"
# shellcheck disable=SC1090
. "$LIB"

SANDBOX="$(mktemp -d)"
# shellcheck disable=SC2064
trap 'if [ -n "${SUP_PID:-}" ]; then kill -TERM "$SUP_PID" 2>/dev/null || true; wait "$SUP_PID" 2>/dev/null || true; fi; rm -rf "$SANDBOX"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

start_supervisor() {
  local bin="$1"
  rm -f "$SANDBOX/sup.pid"
  cat >"$SANDBOX/spawn.py" <<'PY'
import os, signal, sys
lib, binary, out_path, err_path, pid_path = sys.argv[1:6]
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
try:
    os.setsid()
except OSError:
    pass
os.dup2(os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644), 1)
os.dup2(os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644), 2)
with open(pid_path, "w") as fh:
    fh.write(str(os.getpid()))
bash = os.environ.get("TEST_BASH", "/bin/bash")
os.execv(bash, [bash, "-c", '. "$1"; supervise_agent_server "$2"', "_", lib, binary])
PY
  TEST_BASH="$(command -v bash)" python3 "$SANDBOX/spawn.py" "$LIB" "$bin" "$SANDBOX/sup.out" "$SANDBOX/sup.err" "$SANDBOX/sup.pid" &
  wait_file "$SANDBOX/sup.pid"
  SUP_PID=$(cat "$SANDBOX/sup.pid")
}

alive() {
  kill -0 "$1" 2>/dev/null
}

wait_file() {
  local path="$1" deadline=$((SECONDS + 8))
  while [ ! -s "$path" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.05
  done
  if [ ! -s "$path" ]; then
    fail "timed out waiting for $path"
  fi
}

wait_exit() {
  local pid="$1" deadline=$((SECONDS + 8))
  while alive "$pid" && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.05
  done
  if alive "$pid"; then
    fail "process $pid still alive"
  fi
}

# --- 137 recovery: SIGKILL child once, second launch must start ---
COUNT137="$SANDBOX/count137"
PID137="$SANDBOX/pid137"
cat >"$SANDBOX/bin137" <<EOF
#!/bin/sh
n=\$(( \$(cat "$COUNT137" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "$COUNT137"
echo \$\$ > "$PID137"
# Stay up so the supervisor can observe the kill / second launch.
while true; do sleep 30; done
EOF
chmod +x "$SANDBOX/bin137"

start_supervisor "$SANDBOX/bin137"
wait_file "$PID137"
first_pid=$(cat "$PID137")
kill -KILL "$first_pid"
wait_exit "$first_pid"
deadline=$((SECONDS + 8))
while [ "$(cat "$COUNT137" 2>/dev/null || echo 0)" -lt 2 ] && [ "$SECONDS" -lt "$deadline" ]; do
  sleep 0.05
done
[ "$(cat "$COUNT137")" -ge 2 ] || fail "137 did not restart (count=$(cat "$COUNT137" 2>/dev/null || echo 0))"
second_pid=$(cat "$PID137")
[ "$second_pid" != "$first_pid" ] || fail "137 restart reused the first pid"
kill -TERM "$SUP_PID"
wait "$SUP_PID" || true
SUP_PID=""
if alive "$second_pid"; then
  fail "137 child survived supervisor TERM"
fi
echo "ok: 137 recovery relaunches once"

# --- permanent startup failure: exit 1 must not loop ---
COUNT1="$SANDBOX/count1"
cat >"$SANDBOX/bin1" <<EOF
#!/bin/sh
n=\$(( \$(cat "$COUNT1" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "$COUNT1"
exit 1
EOF
chmod +x "$SANDBOX/bin1"
start=$(date +%s)
set +e
bash -c '. "$1"; supervise_agent_server "$2"' _ "$LIB" "$SANDBOX/bin1" \
  >"$SANDBOX/fail.out" 2>"$SANDBOX/fail.err"
rc=$?
set -e
elapsed=$(( $(date +%s) - start ))
[ "$rc" -eq 1 ] || fail "exit 1 supervisor rc=$rc"
[ "$(cat "$COUNT1")" -eq 1 ] || fail "exit 1 launched $(cat "$COUNT1") times"
[ "$elapsed" -lt 3 ] || fail "exit 1 took ${elapsed}s (looped)"
grep -Fq "not restarting" "$SANDBOX/fail.out" "$SANDBOX/fail.err" || fail "exit 1 missing fail-fast log"
echo "ok: permanent exit 1 fail-fast"

# --- TERM to supervisor: one forwarded signal, no restart, no surviving child ---
run_signal_case() {
  local sig="$1" expect="$2"
  local dir="$SANDBOX/$sig"
  mkdir -p "$dir"
  cat >"$dir/bin" <<EOF
#!/bin/sh
echo launch >> "$dir/launches"
exec python3 -c "import os, signal, time, pathlib
pathlib.Path('$dir/pid').write_text(str(os.getpid()))
got = pathlib.Path('$dir/got')
def handle(signum, _frame):
    got.write_text('term' if signum == signal.SIGTERM else 'int')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, handle)
signal.signal(signal.SIGINT, handle)
time.sleep(60)
"
EOF
  chmod +x "$dir/bin"
  start_supervisor "$dir/bin"
  wait_file "$dir/pid"
  child=$(cat "$dir/pid")
  kill -s "$sig" "$SUP_PID"
  set +e
  wait_deadline=$((SECONDS + 8))
  while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
    sleep 0.05
  done
  if alive "$SUP_PID"; then
    echo "--- supervisor still running pid=$SUP_PID child=$child ---" >&2
    ps -p "$SUP_PID" -o pid,ppid,stat,command >&2 || true
    echo "--- sup.out ---" >&2
    cat "$SANDBOX/sup.out" >&2 || true
    echo "--- sup.err ---" >&2
    cat "$SANDBOX/sup.err" >&2 || true
    fail "$sig supervisor still running"
  fi
  wait "$SUP_PID"
  sup_rc=$?
  set -e
  SUP_PID=""
  wait_exit "$child"
  wait_file "$dir/got"
  got=$(cat "$dir/got")
  [ "$got" = "$expect" ] || fail "$sig forwarded as '$got'"
  launches=$(wc -l < "$dir/launches" | tr -d ' ')
  [ "$launches" -eq 1 ] || fail "$sig caused $launches launches"
  if alive "$child"; then
    fail "$sig left child $child alive"
  fi
  [ "$sup_rc" -eq 0 ] || fail "$sig supervisor rc=$sup_rc"
  echo "ok: $sig forwarded once, no restart, child reaped"
}

run_signal_case TERM term
run_signal_case INT int

# --- ignoring child: grace then KILL, supervisor must not hang ---
IGNORE_DIR="$SANDBOX/ignore"
mkdir -p "$IGNORE_DIR"
cat >"$IGNORE_DIR/bin" <<EOF
#!/bin/sh
echo launch >> "$IGNORE_DIR/launches"
exec python3 -c "import os, signal, time, pathlib
pathlib.Path('$IGNORE_DIR/pid').write_text(str(os.getpid()))
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
time.sleep(60)
"
EOF
chmod +x "$IGNORE_DIR/bin"
export AGENT_SERVER_SHUTDOWN_GRACE_SEC=1
start=$(date +%s)
start_supervisor "$IGNORE_DIR/bin"
wait_file "$IGNORE_DIR/pid"
ignore_child=$(cat "$IGNORE_DIR/pid")
kill -TERM "$SUP_PID"
set +e
wait_deadline=$((SECONDS + 5))
while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
  sleep 0.05
done
if alive "$SUP_PID"; then
  fail "ignoring child hung supervisor"
fi
wait "$SUP_PID"
set -e
SUP_PID=""
elapsed=$(( $(date +%s) - start ))
wait_exit "$ignore_child"
[ "$elapsed" -lt 4 ] || fail "ignoring-child shutdown took ${elapsed}s"
if alive "$ignore_child"; then
  fail "ignoring child survived KILL"
fi
grep -Fq "sending KILL" "$SANDBOX/sup.out" "$SANDBOX/sup.err" || fail "missing KILL escalation log"
echo "ok: ignoring child escalates to KILL within bound"
unset AGENT_SERVER_SHUTDOWN_GRACE_SEC

# --- launch race: TERM during start delay, no orphan child ---
RACE_DIR="$SANDBOX/race"
mkdir -p "$RACE_DIR"
cat >"$RACE_DIR/bin" <<EOF
#!/bin/sh
echo launch >> "$RACE_DIR/launches"
echo \$\$ > "$RACE_DIR/pid"
while true; do sleep 30; done
EOF
chmod +x "$RACE_DIR/bin"
export AGENT_SERVER_START_DELAY_SEC=1
export AGENT_SERVER_SHUTDOWN_GRACE_SEC=1
start_supervisor "$RACE_DIR/bin"
# Signal before the delayed launch assigns SERVER_PID.
sleep 0.15
kill -TERM "$SUP_PID"
set +e
wait_deadline=$((SECONDS + 6))
while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
  sleep 0.05
done
if alive "$SUP_PID"; then
  fail "start-delay race hung supervisor"
fi
wait "$SUP_PID"
set -e
SUP_PID=""
if [ -f "$RACE_DIR/pid" ]; then
  race_child=$(cat "$RACE_DIR/pid")
  wait_exit "$race_child"
fi
if [ -f "$RACE_DIR/launches" ]; then
  launches=$(wc -l < "$RACE_DIR/launches" | tr -d ' ')
else
  launches=0
fi
[ "$launches" -le 1 ] || fail "start-delay race launched $launches times"
echo "ok: start-delay shutdown reaps any late child"
unset AGENT_SERVER_START_DELAY_SEC
unset AGENT_SERVER_SHUTDOWN_GRACE_SEC

# --- restart-sleep race: TERM during the 1s delay, no second launch ---
SLEEP_DIR="$SANDBOX/sleep"
mkdir -p "$SLEEP_DIR"
cat >"$SLEEP_DIR/bin" <<EOF
#!/bin/sh
n=\$(( \$(cat "$SLEEP_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "$SLEEP_DIR/count"
echo \$\$ > "$SLEEP_DIR/pid"
exit 0
EOF
chmod +x "$SLEEP_DIR/bin"
export AGENT_SERVER_RESTART_SLEEP_SEC=2
start_supervisor "$SLEEP_DIR/bin"
wait_file "$SLEEP_DIR/count"
# First child already exited 0; supervisor is in restart sleep.
sleep 0.2
set +e
kill -TERM "$SUP_PID" 2>/dev/null
wait_deadline=$((SECONDS + 6))
while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
  sleep 0.05
done
if alive "$SUP_PID"; then
  fail "restart-sleep race hung supervisor"
fi
wait "$SUP_PID"
set -e
SUP_PID=""
[ "$(cat "$SLEEP_DIR/count")" -eq 1 ] || fail "restart-sleep launched $(cat "$SLEEP_DIR/count") times"
echo "ok: shutdown during restart sleep does not relaunch"
unset AGENT_SERVER_RESTART_SLEEP_SEC

# --- exact-once TERM delivery ---
ONCE_DIR="$SANDBOX/once"
mkdir -p "$ONCE_DIR"
cat >"$ONCE_DIR/bin" <<EOF
#!/bin/sh
echo launch >> "$ONCE_DIR/launches"
exec python3 -c "import os, signal, time, pathlib
pathlib.Path('$ONCE_DIR/pid').write_text(str(os.getpid()))
n = 0
def handle(signum, _frame):
    global n
    n += 1
    pathlib.Path('$ONCE_DIR/count').write_text(str(n))
    if signum in (signal.SIGTERM, signal.SIGINT):
        raise SystemExit(0)
signal.signal(signal.SIGTERM, handle)
signal.signal(signal.SIGINT, handle)
time.sleep(60)
"
EOF
chmod +x "$ONCE_DIR/bin"
start_supervisor "$ONCE_DIR/bin"
wait_file "$ONCE_DIR/pid"
once_child=$(cat "$ONCE_DIR/pid")
kill -TERM "$SUP_PID"
set +e
wait_deadline=$((SECONDS + 8))
while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
  sleep 0.05
done
wait "$SUP_PID" 2>/dev/null
set -e
SUP_PID=""
wait_file "$ONCE_DIR/count"
[ "$(cat "$ONCE_DIR/count")" -eq 1 ] || fail "TERM delivered $(cat "$ONCE_DIR/count") times"
wait_exit "$once_child"
echo "ok: TERM delivered exactly once"

# --- owned-child identity rejects a reused / foreign pid ---
FOREIGN=$(sh -c 'sleep 30 >/dev/null 2>&1 & echo $!')
sleep 0.1
SERVER_PID="$FOREIGN"
SERVER_START=""
SERVER_PGID=""
SERVER_SID=""
if _supervise_owned_child; then
  kill "$FOREIGN" 2>/dev/null || true
  fail "foreign pid accepted as owned child"
fi
# Live pid + foreign pgid/sid still reject when starttime does not match.
SERVER_START="not-the-real-starttime"
SERVER_PGID=$(_supervise_child_pgid "$FOREIGN")
SERVER_SID=$(_supervise_child_sid "$FOREIGN")
if _supervise_owned_child; then
  kill "$FOREIGN" 2>/dev/null || true
  fail "mismatched starttime accepted as owned child"
fi
# Record the real identity, then corrupt session: must reject.
_supervise_record_child
_supervise_owned_child || { kill "$FOREIGN" 2>/dev/null || true; fail "just-recorded child not owned"; }
SERVER_SID="not-the-real-sid"
if _supervise_owned_child; then
  kill "$FOREIGN" 2>/dev/null || true
  fail "mismatched session accepted as owned child"
fi
kill "$FOREIGN" 2>/dev/null || true
wait "$FOREIGN" 2>/dev/null || true
_supervise_clear_child
echo "ok: PID-reuse identity rejects foreign process"

# --- delayed setsid: record only after pgid/sid == pid ---
DELAY_DIR="$SANDBOX/delay-setsid"
mkdir -p "$DELAY_DIR/binfirst"
cat >"$DELAY_DIR/binfirst/setsid" <<'EOF'
#!/usr/bin/env python3
import os, sys, time
time.sleep(0.4)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
EOF
chmod +x "$DELAY_DIR/binfirst/setsid"
cat >"$DELAY_DIR/bin" <<EOF
#!/bin/sh
echo launch >> "$DELAY_DIR/launches"
exec python3 -c "import os, signal, time, pathlib
pathlib.Path('$DELAY_DIR/pid').write_text(str(os.getpid()))
def handle(signum, _frame):
    pathlib.Path('$DELAY_DIR/got').write_text('term')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, handle)
time.sleep(60)
"
EOF
chmod +x "$DELAY_DIR/bin"
PATH="$DELAY_DIR/binfirst:$PATH" start_supervisor "$DELAY_DIR/bin"
wait_file "$DELAY_DIR/pid"
delay_child=$(cat "$DELAY_DIR/pid")
# Supervisor must still own the child after the delayed setsid transition.
sleep 0.15
if ! alive "$delay_child"; then
  fail "delayed-setsid child died before TERM"
fi
[ "$(_supervise_child_pgid "$delay_child")" = "$delay_child" ] || fail "delayed-setsid child is not group leader"
kill -TERM "$SUP_PID"
set +e
wait_deadline=$((SECONDS + 8))
while alive "$SUP_PID" && [ "$SECONDS" -lt "$wait_deadline" ]; do
  sleep 0.05
done
if alive "$SUP_PID"; then
  fail "delayed-setsid supervisor still running"
fi
wait "$SUP_PID" 2>/dev/null
set -e
SUP_PID=""
wait_exit "$delay_child"
if alive "$delay_child"; then
  fail "delayed-setsid child survived supervisor"
fi
wait_file "$DELAY_DIR/got"
[ "$(cat "$DELAY_DIR/got")" = "term" ] || fail "delayed-setsid child missed TERM"
launches=$(wc -l < "$DELAY_DIR/launches" | tr -d ' ')
[ "$launches" -eq 1 ] || fail "delayed-setsid launched $launches times"
echo "ok: delayed setsid child stays owned and is reaped"

echo "entrypoint supervise: 137 recovery, fail-fast, TERM/INT, grace-KILL, launch/sleep races, exact-once, delayed-setsid"
