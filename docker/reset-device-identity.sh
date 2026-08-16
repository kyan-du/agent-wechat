#!/usr/bin/env sh
set -eu

root="${AGENT_WECHAT_IDENTITY_DIR:-/data/device-identity}"
if [ "${AGENT_WECHAT_RESET_TESTING:-0}" != 1 ] && [ "$root" != /data/device-identity ]; then
  echo "[identity-reset] ERROR: identity root is outside the audited scope" >&2
  exit 40
fi
[ ! -L "$root" ] || { echo "[identity-reset] ERROR: identity root is a symlink" >&2; exit 41; }
[ ! -e "$root" ] || [ -d "$root" ] || { echo "[identity-reset] ERROR: identity root is not a directory" >&2; exit 42; }

for name in machine-id hostname; do
  target="$root/$name"
  [ ! -L "$target" ] || { echo "[identity-reset] ERROR: $name is a symlink" >&2; exit 43; }
  [ ! -e "$target" ] || [ -f "$target" ] || { echo "[identity-reset] ERROR: $name is not a regular file" >&2; exit 44; }
done

rm -f -- "$root/machine-id" "$root/hostname"
rmdir -- "$root" 2>/dev/null || true
[ ! -e "$root/machine-id" ] && [ ! -e "$root/hostname" ]
