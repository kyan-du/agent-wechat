#!/usr/bin/env bash
# Container identity.sh must fail closed on hostname, MAC, or machine-id mismatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IDSH="$ROOT/docker/identity.sh"
chmod +x "$IDSH"

run_id() {
  local work="$1"
  shift
  mkdir -p "$work/bin" "$work/net/eth0" "$work/data"
  cat >"$work/bin/hostname" <<'EOF'
#!/bin/sh
# Report the live hostname only; ignore set attempts (no UTS).
cat "${FAKE_HN_FILE}"
EOF
  chmod +x "$work/bin/hostname"
  printf '%s\n' "${FAKE_HN}" >"$work/hn"
  printf '%s\n' "${FAKE_MAC}" >"$work/net/eth0/address"
  env -i \
    PATH="$work/bin:/usr/bin:/bin" \
    HOME="$work" \
    AGENT_WECHAT_IDENTITY_DIR="$work/data" \
    AGENT_WECHAT_NET_DIR="$work/net" \
    AGENT_WECHAT_SPOOF_OS=0 \
    FAKE_HN_FILE="$work/hn" \
    AGENT_WECHAT_MACHINE_ID="${AGENT_WECHAT_MACHINE_ID:-}" \
    AGENT_WECHAT_HOSTNAME="${AGENT_WECHAT_HOSTNAME:-}" \
    AGENT_WECHAT_MAC="${AGENT_WECHAT_MAC:-}" \
    bash "$IDSH"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

FAKE_HN="lenovo-pc-100"
FAKE_MAC="00:1b:21:00:00:01"
export AGENT_WECHAT_MACHINE_ID="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
export AGENT_WECHAT_HOSTNAME="lenovo-pc-100"
export AGENT_WECHAT_MAC="00:1b:21:00:00:01"
run_id "$work/ok"
test "$(cat "$work/ok/data/machine-id")" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# Persisted machine-id conflict is not overwritten.
printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' >"$work/ok/data/machine-id"
if run_id "$work/ok" >/dev/null 2>"$work/conflict.err"; then
  echo "machine-id conflict should fail" >&2
  exit 1
fi
test "$(cat "$work/ok/data/machine-id")" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
grep -Fq "exact match" "$work/conflict.err"

# Trailing garbage after 32 hex is not normalized away.
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-TRAILING\n' >"$work/ok/data/machine-id"
if run_id "$work/ok" >/dev/null 2>"$work/trail.err"; then
  echo "trailing machine-id garbage should fail" >&2
  exit 1
fi
test "$(cat "$work/ok/data/machine-id")" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-TRAILING"
grep -Fq "exact match" "$work/trail.err"

# MAC mismatch
FAKE_MAC="ae:c5:03:99:62:9f"
if run_id "$work/mac" >/dev/null 2>"$work/mac.err"; then
  echo "MAC mismatch should fail" >&2
  exit 1
fi
grep -Fq "MAC is" "$work/mac.err"

# Hostname mismatch
FAKE_MAC="00:1b:21:00:00:01"
FAKE_HN="other-host"
if run_id "$work/hn" >/dev/null 2>"$work/hn.err"; then
  echo "hostname mismatch should fail" >&2
  exit 1
fi
grep -Fq "hostname is" "$work/hn.err"

echo "container identity: full-tuple mismatch fails closed"
