#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
command -v jq >/dev/null || { echo 'jq is required' >&2; exit 2; }
mapfile_cmd=''
packages=()
while IFS= read -r manifest; do
  if jq -e '(.private // false) == false and (.publishConfig.access // "") == "public"' "$manifest" >/dev/null; then
    packages+=("${manifest%/package.json}")
  fi
done < <(find packages -mindepth 2 -maxdepth 2 -name package.json -print | LC_ALL=C sort)
((${#packages[@]})) || { echo 'no public packages found' >&2; exit 1; }
for dir in "${packages[@]}"; do
  name=$(jq -r .name "$dir/package.json")
  jq -e 'has("files") and (.files|type=="array") and (.files|length>0)' "$dir/package.json" >/dev/null || { echo "$name: missing non-empty files allowlist" >&2; exit 1; }
  report=$(cd "$dir" && npm pack --dry-run --json)
  echo "$report" | jq -e '(type=="array") and (length==1) and ((.[0].files|length)>0)' >/dev/null
  bad=$(echo "$report" | jq -r '.[0].files[].path' | LC_ALL=C sort | grep -Ei '(^|/)(\.env($|\.)|credentials?|secrets?|tokens?|cache|coverage|fixtures?|tmp|temp|\.data|node_modules)(/|$)|(^|/)(qr|qrcode|screenshot)([-_.]|/|$)|\.(deb|rpm|apk|exe|dll|dylib|so([.][0-9]+)*|node|a|o|db|sqlite|sqlite3|wal|shm|pem|key|p12|log|tgz|tar|zip|gz|map)$' || true)
  [[ -z "$bad" ]] || { printf '%s: forbidden packed paths:\n%s\n' "$name" "$bad" >&2; exit 1; }
  echo "$name"
  echo "$report" | jq -r '.[0].files[].path' | LC_ALL=C sort | sed 's/^/  /'
done
