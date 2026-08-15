#!/usr/bin/env bash
# Supervise agent-server: restart recoverable exits, fail-fast otherwise,
# and forward container stop signals to the current child.

# Recoverable: graceful hot-swap (0), SIGKILL (137), SIGTERM if unhandled (143).
# Override in tests via env; keep the default list conservative.
: "${AGENT_SERVER_RECOVERABLE_EXITS:=0 137 143}"
: "${AGENT_SERVER_RAPID_RESTART_LIMIT:=5}"
: "${AGENT_SERVER_RAPID_RESTART_WINDOW_SEC:=15}"

SERVER_PID=""
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

_supervise_start() {
  local bin="$1"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$bin" &
  else
    "$bin" &
  fi
  SERVER_PID=$!
}

_supervise_signal_child() {
  local sig="$1"
  local pgid=""
  if [ -z "${SERVER_PID:-}" ]; then
    return 0
  fi
  # Always signal the child first so its graceful handler runs.
  kill -s "$sig" "$SERVER_PID" 2>/dev/null || true
  # If it is a process-group leader (setsid), also stop owned grandchildren.
  pgid=$(ps -o pgid= -p "$SERVER_PID" 2>/dev/null | tr -d ' ')
  if [ -n "$pgid" ] && [ "$pgid" = "$SERVER_PID" ]; then
    kill -s "$sig" -- "-$SERVER_PID" 2>/dev/null || true
  fi
}

_supervise_on_signal() {
  echo "agent-server supervisor caught $1 (child=${SERVER_PID:-none})"
  SHUTDOWN_REQUESTED=1
  _supervise_signal_child "$1"
}

supervise_agent_server() {
  local bin="$1"
  local exit_code=0

  SERVER_PID=""
  SHUTDOWN_REQUESTED=0
  _SUPERVISE_RECENT_RESTARTS=""

  trap '_supervise_on_signal TERM' TERM
  trap '_supervise_on_signal INT' INT
  echo "agent-server supervisor ready pid=$$"

  while true; do
    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      echo "agent-server supervisor stopping before launch."
      exit 0
    fi

    _supervise_start "$bin"

    set +e
    wait "$SERVER_PID"
    exit_code=$?
    set -e
    # If wait was interrupted, the trap runs before the next command.
    # `true` gives a known status after that flush.
    true

    if [ "$SHUTDOWN_REQUESTED" -ne 0 ]; then
      if kill -0 "$SERVER_PID" 2>/dev/null; then
        set +e
        wait "$SERVER_PID"
        exit_code=$?
        set -e
      fi
      SERVER_PID=""
      echo "agent-server shutdown ($exit_code), stopping."
      exit 0
    fi
    SERVER_PID=""

    if ! _supervise_recoverable "$exit_code"; then
      echo "agent-server exited ($exit_code), not restarting."
      exit "$exit_code"
    fi

    if _supervise_rapid_restart_exceeded "$(date +%s)"; then
      echo "agent-server crash-looped (last=$exit_code), giving up."
      exit "$exit_code"
    fi

    echo "agent-server exited ($exit_code), restarting in 1s..."
    set +e
    sleep 1
    set -e
  done
}
