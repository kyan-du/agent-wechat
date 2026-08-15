#!/usr/bin/env bash
# Supervise agent-server: restart recoverable exits, fail-fast otherwise,
# and forward container stop signals to the current child.

# Recoverable: graceful hot-swap (0), SIGKILL (137), SIGTERM if unhandled (143).
# Override in tests via env; keep the default list conservative.
: "${AGENT_SERVER_RECOVERABLE_EXITS:=0 137 143}"
: "${AGENT_SERVER_RAPID_RESTART_LIMIT:=5}"
: "${AGENT_SERVER_RAPID_RESTART_WINDOW_SEC:=15}"
: "${AGENT_SERVER_SHUTDOWN_GRACE_SEC:=5}"
: "${AGENT_SERVER_RESTART_SLEEP_SEC:=1}"
: "${AGENT_SERVER_START_DELAY_SEC:=0}"
: "${AGENT_SERVER_IDENTITY_WAIT_SEC:=2}"

SERVER_PID=""
SERVER_START=""
SERVER_PGID=""
SERVER_SID=""
SHUTDOWN_REQUESTED=0
_SUPERVISE_RECENT_RESTARTS=""

_supervise_recoverable() {
  local code="$1" item
  for item in $AGENT_SERVER_RECOVERABLE_EXITS; do
    if [ "$item" = "$code" ]; then
      return 0
    fi
  done
  return 1
}

_supervise_rapid_restart_exceeded() {
  local now="$1" kept="" t n=0
  for t in $_SUPERVISE_RECENT_RESTARTS; do
    if [ $((now - t)) -lt "$AGENT_SERVER_RAPID_RESTART_WINDOW_SEC" ]; then
      kept="$kept $t"
      n=$((n + 1))
    fi
  done
  n=$((n + 1))
  _SUPERVISE_RECENT_RESTARTS="$kept $now"
  [ "$n" -gt "$AGENT_SERVER_RAPID_RESTART_LIMIT" ]
}

# Field after the comm in /proc/<pid>/stat: 1=state 2=ppid 3=pgrp 4=session 20=starttime.
_supervise_stat_field() {
  local pid="$1" field="$2" stat rest n=1 tok
  stat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  for tok in $rest; do
    if [ "$n" -eq "$field" ]; then
      [ -n "$tok" ] || return 1
      echo "$tok"
      return 0
    fi
    n=$((n + 1))
  done
  return 1
}

_supervise_child_pgid() {
  local v
  if [ -r "/proc/$1/stat" ]; then
    v=$(_supervise_stat_field "$1" 3) && [ -n "$v" ] && { echo "$v"; return 0; }
  fi
  ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}

_supervise_child_sid() {
  local v
  if [ -r "/proc/$1/stat" ]; then
    v=$(_supervise_stat_field "$1" 4) && [ -n "$v" ] && { echo "$v"; return 0; }
  fi
  ps -o sess= -p "$1" 2>/dev/null | tr -d ' '
}

# Immutable process identity: Linux starttime from /proc, else lstart.
# Do not use PPID — container PID 1 adopts orphans.
_supervise_starttime() {
  local pid="$1" v
  if [ -r "/proc/$pid/stat" ]; then
    v=$(_supervise_stat_field "$pid" 20) && [ -n "$v" ] && { echo "$v"; return 0; }
  fi
  ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# setsid changes pgid/sid after fork. Wait until the child is group leader
# (pgid == pid). On Linux also require session == pid; BSD ps reports sess=0
# for every process, so sid cannot mark the transition there.
_supervise_wait_setsid_identity() {
  local pgid="" sid=""
  local deadline=$((SECONDS + ${AGENT_SERVER_IDENTITY_WAIT_SEC:-2}))
  while [ "$SECONDS" -le "$deadline" ]; do
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    pgid=$(_supervise_child_pgid "$SERVER_PID")
    sid=$(_supervise_child_sid "$SERVER_PID")
    if [ "$pgid" = "$SERVER_PID" ]; then
      if [ -r "/proc/$SERVER_PID/stat" ]; then
        [ "$sid" = "$SERVER_PID" ] || { sleep 0.02; continue; }
      fi
      return 0
    fi
    sleep 0.02
  done
  return 1
}

_supervise_record_child() {
  local start="" pgid="" sid=""
  SERVER_START=""
  SERVER_PGID=""
  SERVER_SID=""
  start=$(_supervise_starttime "$SERVER_PID")
  pgid=$(_supervise_child_pgid "$SERVER_PID")
  sid=$(_supervise_child_sid "$SERVER_PID")
  if [ -z "$start" ] || [ -z "$pgid" ]; then
    return 1
  fi
  SERVER_START="$start"
  SERVER_PGID="$pgid"
  SERVER_SID="$sid"
  return 0
}

_supervise_clear_child() {
  SERVER_PID=""
  SERVER_START=""
  SERVER_PGID=""
  SERVER_SID=""
}

# True only while live pid + starttime + pgid + session match launch.
_supervise_owned_child() {
  local start="" pgid="" sid=""
  [ -n "${SERVER_PID:-}" ] && [ -n "${SERVER_START:-}" ] || return 1
  kill -0 "$SERVER_PID" 2>/dev/null || return 1
  start=$(_supervise_starttime "$SERVER_PID")
  [ -n "$start" ] && [ "$start" = "$SERVER_START" ] || return 1
  if [ -n "${SERVER_PGID:-}" ]; then
    pgid=$(_supervise_child_pgid "$SERVER_PID")
    [ "$pgid" = "$SERVER_PGID" ] || return 1
  fi
  if [ -n "${SERVER_SID:-}" ]; then
    sid=$(_supervise_child_sid "$SERVER_PID")
    [ "$sid" = "$SERVER_SID" ] || return 1
  fi
  return 0
}

_supervise_kill_unrecorded() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  _supervise_clear_child
}

_supervise_start() {
  local bin="$1" used_setsid=0
  if [ "${AGENT_SERVER_START_DELAY_SEC:-0}" != 0 ]; then
    sleep "$AGENT_SERVER_START_DELAY_SEC"
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid "$bin" &
    used_setsid=1
  else
    "$bin" &
  fi
  SERVER_PID=$!
  if [ "$used_setsid" -eq 1 ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    if ! _supervise_wait_setsid_identity; then
      if kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "agent-server setsid identity did not stabilize"
        _supervise_kill_unrecorded
        return 1
      fi
      # Child exited during the session transition; wait() will see it.
      return 0
    fi
  fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    if ! _supervise_record_child; then
      echo "agent-server launch identity incomplete"
      _supervise_kill_unrecorded
      return 1
    fi
  fi
  return 0
}

# Exactly one delivery: group signal iff the owned child is the leader.
_supervise_signal_child() {
  local sig="$1" pgid=""
  _supervise_owned_child || return 0
  pgid=$(_supervise_child_pgid "$SERVER_PID")
  if [ -n "$pgid" ] && [ "$pgid" = "$SERVER_PID" ]; then
    kill -s "$sig" -- "-$SERVER_PID" 2>/dev/null || true
  else
    kill -s "$sig" "$SERVER_PID" 2>/dev/null || true
  fi
}

_supervise_on_signal() {
  echo "agent-server supervisor caught $1 (child=${SERVER_PID:-none})"
  SHUTDOWN_REQUESTED=1
  _supervise_signal_child "$1"
}

_supervise_finish_shutdown() {
  local exit_code=0
  local grace="${AGENT_SERVER_SHUTDOWN_GRACE_SEC:-5}"
  local deadline=$((SECONDS + grace))
  if _supervise_owned_child; then
    while _supervise_owned_child && [ "$SECONDS" -lt "$deadline" ]; do
      sleep 0.05
    done
    if _supervise_owned_child; then
      echo "agent-server still running after ${grace}s, sending KILL"
      _supervise_signal_child KILL
    fi
    set +e
    wait "$SERVER_PID"
    exit_code=$?
    set -e
  fi
  _supervise_clear_child
  echo "agent-server shutdown ($exit_code), stopping."
  exit 0
}

supervise_agent_server() {
  local bin="$1"
  local exit_code=0

  _supervise_clear_child
  SHUTDOWN_REQUESTED=0
  _SUPERVISE_RECENT_RESTARTS=""

  trap '_supervise_on_signal TERM' TERM
  trap '_supervise_on_signal INT' INT
  echo "agent-server supervisor ready pid=$$"

  while true; do
    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      echo "agent-server supervisor stopping before launch."
      _supervise_finish_shutdown
    fi

    if ! _supervise_start "$bin"; then
      echo "agent-server launch identity failed, not restarting."
      exit 1
    fi
    # TERM/INT may have arrived after the pre-launch check and before
    # SERVER_PID was assigned. Signal that child before waiting.
    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      echo "agent-server launched after shutdown, stopping."
      _supervise_signal_child TERM
      _supervise_finish_shutdown
    fi

    set +e
    wait "$SERVER_PID"
    exit_code=$?
    set -e
    true

    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      _supervise_finish_shutdown
    fi
    _supervise_clear_child

    if ! _supervise_recoverable "$exit_code"; then
      echo "agent-server exited ($exit_code), not restarting."
      exit "$exit_code"
    fi

    if _supervise_rapid_restart_exceeded "$(date +%s)"; then
      echo "agent-server crash-looped (last=$exit_code), giving up."
      exit "$exit_code"
    fi

    echo "agent-server exited ($exit_code), restarting in ${AGENT_SERVER_RESTART_SLEEP_SEC}s..."
    set +e
    sleep "$AGENT_SERVER_RESTART_SLEEP_SEC"
    set -e
    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      echo "agent-server shutdown during restart delay, stopping."
      _supervise_finish_shutdown
    fi
  done
}
