#!/usr/bin/env bash
# Xvfb and x11vnc must start as the WeChat user so MIT-SHM segments are readable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/docker/entrypoint.sh"
test -f "$ENTRY"

grep -Fq 'su -s /bin/bash -c "DISPLAY=$DISPLAY Xvfb $DISPLAY -screen 0 1280x800x24" wechat &' "$ENTRY"
grep -Fq 'su -s /bin/bash -c "DISPLAY=$DISPLAY HOME=$WECHAT_HOME x11vnc -display $DISPLAY -forever -nopw -shared -viewonly -xkb -rfbport 5900 -listen 127.0.0.1" wechat &' "$ENTRY"

xvfb_line=$(grep -nF 'su -s /bin/bash -c "DISPLAY=$DISPLAY Xvfb $DISPLAY -screen 0 1280x800x24" wechat &' "$ENTRY" | cut -d: -f1)
vnc_line=$(grep -nF 'su -s /bin/bash -c "DISPLAY=$DISPLAY HOME=$WECHAT_HOME x11vnc -display $DISPLAY -forever -nopw -shared -viewonly -xkb -rfbport 5900 -listen 127.0.0.1" wechat &' "$ENTRY" | cut -d: -f1)
launch_line=$(grep -nF 'launch-wechat &' "$ENTRY" | cut -d: -f1)
test "$xvfb_line" -lt "$launch_line"
test "$vnc_line" -gt "$xvfb_line"

# Root PID 1 must not own the WeChat display server or VNC attach.
if grep -E '^(Xvfb|x11vnc) ' "$ENTRY"; then
  echo "entrypoint starts Xvfb/x11vnc as PID 1/root for the WeChat display" >&2
  exit 1
fi

echo "entrypoint Xvfb: launched as wechat before WeChat"
