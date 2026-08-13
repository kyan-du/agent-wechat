#!/usr/bin/env bash
# Identity failure must abort the real entrypoint before launch-wechat.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/docker/entrypoint.sh"
test -f "$ENTRY"

# Contract: the production invocation does not swallow identity.sh.
if grep -E '/opt/identity\.sh[[:space:]]*\|\|' "$ENTRY"; then
  echo "entrypoint swallows identity.sh failure" >&2
  exit 1
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
MARKER="$SANDBOX/wechat-launched"

cat > "$SANDBOX/identity.sh" <<'EOF'
#!/bin/sh
echo "[identity] ERROR: hostname is 'sandbox', want 'lenovo-pc-100'." >&2
exit 1
EOF
chmod +x "$SANDBOX/identity.sh"

# Point the production stanza at the failing identity script. If the
# entrypoint continued, it would eventually call launch-wechat.
sed "s|/opt/identity.sh|$SANDBOX/identity.sh|g" "$ENTRY" > "$SANDBOX/entrypoint.sh"
# If identity were ignored, this stub would create the marker.
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/launch-wechat" <<EOF
#!/bin/sh
echo launched > "$MARKER"
exit 0
EOF
chmod +x "$SANDBOX/bin/launch-wechat" "$SANDBOX/entrypoint.sh"

set +e
PATH="$SANDBOX/bin:$PATH" bash "$SANDBOX/entrypoint.sh" >"$SANDBOX/out" 2>"$SANDBOX/err"
rc=$?
set -e

test "$rc" -ne 0
test ! -f "$MARKER"
grep -Fq "refusing to start WeChat" "$SANDBOX/err" || grep -Fq "hostname is" "$SANDBOX/err"

echo "entrypoint identity: fail-closed, WeChat launch path not reached"
