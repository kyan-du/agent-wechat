#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAGE=$(mktemp -d)
PACKS=$(mktemp -d)
trap 'rm -rf "$STAGE" "$PACKS"' EXIT

cd "$ROOT"
pnpm --filter @kyan-du/agent-wechat-shared build
pnpm --filter @kyan-du/agent-wechat-cli build
TARBALL=$(cd packages/cli && npm pack --silent --ignore-scripts --pack-destination "$PACKS")
mkdir -p "$STAGE/node_modules/qrcode-terminal"
cp -R packages/cli/node_modules/qrcode-terminal/* "$STAGE/node_modules/qrcode-terminal/"
tar -xzf "$PACKS/$TARBALL" -C "$STAGE"
CLI="$STAGE/package/dist/cli.js"
NODE=$(command -v node)
NO_DOCKER_PATH="$STAGE/no-docker-bin"
mkdir -p "$NO_DOCKER_PATH"
cat >"$NO_DOCKER_PATH/npm" <<'EOF'
#!/bin/sh
test "$#" -eq 4
test "$1" = "view"
test "$2" = "@kyan-du/agent-wechat-cli"
test "$3" = "dist-tags.latest"
test "$4" = "--json"
printf '"0.12.1"\n'
EOF
chmod +x "$NO_DOCKER_PATH/npm"

node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.schemaVersion!==1||x.apiVersion!==1||x.repository!=="ghcr.io/kyan-du/agent-wechat"||x.floatingTagsAllowed!==false||!x.allowedReferences.includes("sha256-digest"))process.exit(1)' "$STAGE/package/dist/image-compatibility.json"
node "$CLI" --help | grep -q 'start'
! node "$CLI" --help | grep -Eq '^  (up|down|update|session|dev)\b'
node "$CLI" messages --help | grep -q -- '--cursor'
node "$CLI" auth --help | grep -q 'reset'
node "$CLI" chats --help | grep -q 'mark-read'
set +e
HOME="$STAGE/home" node "$CLI" up >"$STAGE/out" 2>"$STAGE/err"
code=$?
set -e
test "$code" -eq 2
test ! -s "$STAGE/out"
grep -q 'use wx start' "$STAGE/err"
set +e
HOME="$STAGE/home" node "$CLI" --json send wxid_a >"$STAGE/json" 2>"$STAGE/json-err"
json_code=$?
set -e
test "$json_code" -eq 2
test ! -s "$STAGE/json-err"
node -e 'const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");if(lines.length!==1)process.exit(1);const x=JSON.parse(lines[0]);if(x.schemaVersion!==1||x.ok||x.code!=="INVALID_ARGUMENT")process.exit(1)' "$STAGE/json"
set +e
HOME="$STAGE/home" node "$CLI" --json start --pull --offline >"$STAGE/conflict-json" 2>"$STAGE/conflict-err"
conflict_code=$?
set -e
test "$conflict_code" -eq 2
test ! -s "$STAGE/conflict-err"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.schemaVersion!==1||x.ok||x.code!=="ARGUMENT_CONFLICT")process.exit(1)' "$STAGE/conflict-json"
for command in status doctor; do
  set +e
  PATH="$NO_DOCKER_PATH" HOME="$STAGE/home" "$NODE" "$CLI" --json "$command" >"$STAGE/$command-json" 2>"$STAGE/$command-err"
  command_code=$?
  set -e
  test "$command_code" -eq 3
  test ! -s "$STAGE/$command-err"
  node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.schemaVersion!==1||x.ok||x.code!=="DOCKER_UNAVAILABLE"||x.diagnostics?.docker!=="unavailable")process.exit(1)' "$STAGE/$command-json"
done
PATH="$NO_DOCKER_PATH" HOME="$STAGE/home" "$NODE" "$CLI" --json upgrade --cli >"$STAGE/upgrade-json" 2>"$STAGE/upgrade-err"
test ! -s "$STAGE/upgrade-err"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.schemaVersion!==1||!x.ok||x.data.currentVersion!=="0.12.0"||x.data.latestVersion!=="0.12.1"||!x.data.updateAvailable||x.data.command!=="npm install --global @kyan-du/agent-wechat-cli@0.12.1")process.exit(1)' "$STAGE/upgrade-json"
PATH="$NO_DOCKER_PATH" HOME="$STAGE/home" "$NODE" "$CLI" upgrade --cli >"$STAGE/upgrade-human" 2>"$STAGE/upgrade-human-err"
test ! -s "$STAGE/upgrade-human-err"
test "$(cat "$STAGE/upgrade-human")" = "npm install --global @kyan-du/agent-wechat-cli@0.12.1"
node "$ROOT/scripts/test-packed-cli-health.mjs" "$CLI" "$STAGE"

echo 'Packed CLI clean-consumer journeys passed.'
