#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
node scripts/validate-prerelease-contract.mjs

mutate_and_reject() {
  local file=$1 script=$2 label=$3
  cp "$file" "$file.p1b1-test"
  trap 'mv "$file.p1b1-test" "$file" 2>/dev/null || true' RETURN
  node -e "$script" "$file"
  if node scripts/validate-prerelease-contract.mjs >/dev/null 2>&1; then
    echo "prerelease contract accepted: $label" >&2
    exit 1
  fi
  mv "$file.p1b1-test" "$file"
  trap - RETURN
}

mutate_and_reject release/prerelease-contract.json \
  'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.npmDistTag="latest";fs.writeFileSync(p,JSON.stringify(j));' \
  'latest dist-tag'
mutate_and_reject release/prerelease-contract.json \
  'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.requiredApprovals=["owner"];fs.writeFileSync(p,JSON.stringify(j));' \
  'removed legal gate'
mutate_and_reject .changeset/config.json \
  'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.privatePackages.tag=true;fs.writeFileSync(p,JSON.stringify(j));' \
  'private package tags'
mutate_and_reject .changeset/config.json \
  'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.fixed=j.fixed.map(g=>g.filter(n=>!n.endsWith("agent-server")));fs.writeFileSync(p,JSON.stringify(j));' \
  'fixed-group topology drift'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("---\n", "---\nunknown-workspace: patch\n"));' \
  'unknown changeset workspace'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("\"@kyan-du/agent-wechat-cli\": minor", "@kyan-du/agent-wechat-cli: minor"));' \
  'unquoted changeset package key'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("\"@kyan-du/agent-wechat-cli\": minor", "\"@kyan-du/agent-wechat-cli\": prerelease"));' \
  'unsupported changeset bump'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("\"@kyan-du/agent-wechat-cli\": minor", "\"@kyan-du/agent-wechat-cli\": [minor]"));' \
  'unsupported changeset value structure'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8"),line="\"@kyan-du/agent-wechat-cli\": minor";fs.writeFileSync(p,s.replace(line, line+"\n"+line));' \
  'duplicate changeset package key'
mutate_and_reject .changeset/risk-anti-detection.md \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("\"@kyan-du/agent-wechat-cli\": minor", "\"@kyan-du/agent-wechat-cli\" minor"));' \
  'malformed changeset YAML'
mutate_and_reject .github/workflows/release.yml \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("run: ./scripts/test-prerelease-contract.sh","run: npm publish --tag next"));' \
  'npm publish capability'
mutate_and_reject .github/workflows/release.yml \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("- name: Prove validation-only contract\n        run: ./scripts/test-prerelease-contract.sh","- uses: docker/build-push-action@v6\n        with:\n          push: true"));' \
  'image push capability'
mutate_and_reject .github/workflows/release.yml \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("- name: Prove validation-only contract\n        run: ./scripts/test-prerelease-contract.sh","- uses: softprops/action-gh-release@v2"));' \
  'GitHub Release capability'
mutate_and_reject .github/workflows/release.yml \
  'const fs=require("fs"),p=process.argv[1],s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace("  workflow_dispatch:","  workflow_dispatch:\n  push:\n    tags: [v*]"));' \
  'tag-triggered workflow'
mutate_and_reject package.json \
  'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p));j.scripts.release="pnpm changeset publish";fs.writeFileSync(p,JSON.stringify(j));' \
  'root publish script'

if grep -RInE 'changeset publish|push:[[:space:]]*true|docker/login-action|gh release create|git tag|packages:[[:space:]]*write' .github/workflows --exclude=ghcr-prerelease.yml >/dev/null; then
  echo "workflow source contains forbidden publication capability outside the reviewed GHCR workflow" >&2
  exit 1
fi
node scripts/validate-ghcr-release.mjs
if grep -RIn 'npm publish' .github/workflows --exclude=npm-prerelease.yml >/dev/null; then
  echo "npm publication capability exists outside the reviewed prerelease workflow" >&2
  exit 1
fi

git diff --check
test -z "$(git status --porcelain --untracked-files=all | grep -E '\.p1b1-test$' || true)"
echo "prerelease contract negative proofs passed"
