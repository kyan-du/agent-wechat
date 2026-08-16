#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/docker/entrypoint.sh"

# The runtime may mount an empty named volume over /home/wechat. Docker creates
# that mountpoint as root, so entrypoint must hand it back before WeChat starts.
grep -F 'mkdir -p "$WECHAT_HOME"' "$ENTRY" >/dev/null
grep -F 'chown wechat:wechat "$WECHAT_HOME"' "$ENTRY" >/dev/null

mkdir_line=$(grep -nF 'mkdir -p "$WECHAT_HOME"' "$ENTRY" | cut -d: -f1)
launch_line=$(grep -nF 'launch-wechat &' "$ENTRY" | cut -d: -f1)
test "$mkdir_line" -lt "$launch_line"

echo "entrypoint WeChat home: initialized before launch"
