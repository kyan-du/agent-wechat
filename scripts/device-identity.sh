#!/usr/bin/env bash
# Persist one desktop identity per data dir and print shell assignments.
# Used by Compose before `docker compose up` so hostname/MAC are applied at
# create time (the container cannot change UTS hostname with only NET_ADMIN).
#
# Canonical implementation: scripts/device_identity.py (also used by wx up).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/device_identity.py" "$@"
