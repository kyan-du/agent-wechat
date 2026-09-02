import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/npm-release.yml"), "utf8");

assert.match(workflow, /name: Publish stable GHCR image/);
assert.match(workflow, /needs: publish/);
assert.match(workflow, /environment: npm-production/);
assert.match(workflow, /packages: write/);
assert.match(workflow, /VERSION=\$\{\{ inputs\.version \}\}/);
assert.match(workflow, /--tag \"\$IMAGE:\$VERSION\"/);
assert.match(workflow, /linux\/amd64/);
assert.match(workflow, /linux\/arm64/);
assert.doesNotMatch(workflow, /:latest\b/);
assert.doesNotMatch(workflow, /:next\b/);
assert.match(workflow, /test \"\$GITHUB_SHA\" = \"\$\(git rev-parse origin\/main\)\"/);

console.log("npm release includes an authorized exact-version GHCR publication.");
