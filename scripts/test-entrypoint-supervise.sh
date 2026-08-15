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

echo "entrypoint supervise: 137 recovery, fail-fast, TERM/INT forward"
