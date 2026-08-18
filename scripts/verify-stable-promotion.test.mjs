import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes } from "./agent-release-lib.mjs";
import { STABLE_PROMOTION_ALLOWED_PATHS, verifyStablePromotion } from "./verify-stable-promotion.mjs";

const commit = "1".repeat(40), tree = "2".repeat(40), stableCommit = "3".repeat(40), stableTree = "4".repeat(40);
const version = "1.2.3-next.4";
const packages = ["@kyan-du/agent-wechat-cli", "@kyan-du/agent-wechat-openclaw", "@kyan-du/agent-wechat-wechaty-puppet"].map((name, i) => ({ name, version, tarball: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`, sha256: `sha256:${String(i + 5).repeat(64)}`, integrity: "sha512-AAAA", size: 1 }));
const manifest = { schemaVersion: 1, validationOnly: true, repository: "kyan-du/agent-wechat", publisherWorkflow: ".github/workflows/npm-agent-release.yml", channel: "prerelease", version, tag: `v${version}`, commit, tree, registry: "https://registry.npmjs.org", distTag: "next", lockfile: { path: "pnpm-lock.yaml", sha256: `sha256:${"8".repeat(64)}` }, changesets: [], packages };
const manifestRaw = Buffer.from(`${JSON.stringify(manifest)}\n`);
const manifestSha256 = sha256Bytes(manifestRaw);
const canary = { schemaVersion: 1, state: "CANARY_PASSED", repository: manifest.repository, publisherWorkflow: manifest.publisherWorkflow, channel: "prerelease", version, commit, tree, manifestSha256, passedAt: "2026-08-18T00:00:00.000Z" };
const canaryRaw = Buffer.from(`${JSON.stringify(canary)}\n`);
function promotion() { return { schemaVersion: 2, enabled: true, stableVersion: "1.2.3", stableCommit, stableTree, sourcePrerelease: { version, commit, tree, manifestPath: "release/evidence/prerelease.json", manifestSha256, canaryReceiptPath: "release/evidence/canary.json", canaryReceiptSha256: sha256Bytes(canaryRaw) } }; }
function options(changed = ["packages/cli/package.json", "packages/cli/CHANGELOG.md"]) { return { read: (path) => path.includes("canary") ? canaryRaw : manifestRaw, git: (args) => args[0] === "diff" ? changed.join("\n") : args[1].startsWith(stableCommit) ? stableTree : tree, now: Date.parse("2026-08-18T01:00:00.000Z") }; }

test("code-owned allowlist accepts version metadata only", () => assert.equal(verifyStablePromotion(promotion(), options()).canary.state, "CANARY_PASSED"));
test("receipt cannot expand the code-owned allowlist", () => { const value = promotion(); value.allowedDiffPaths = ["app.js"]; assert.throws(() => verifyStablePromotion(value, options(["app.js"])), /exact schema/); });
test("source drift fails even when receipt tries to name it", () => assert.throws(() => verifyStablePromotion(promotion(), options(["app.js"])), /unreviewed source drift/));
test("manifest byte drift fails closed", () => { const value = promotion(); value.sourcePrerelease.manifestSha256 = `sha256:${"9".repeat(64)}`; assert.throws(() => verifyStablePromotion(value, options()), /manifest bytes/); });
test("canary byte drift fails closed", () => { const value = promotion(); value.sourcePrerelease.canaryReceiptSha256 = `sha256:${"9".repeat(64)}`; assert.throws(() => verifyStablePromotion(value, options()), /canary receipt bytes/); });
test("canary identity drift fails closed", () => { const altered = Buffer.from(`${JSON.stringify({ ...canary, commit: "9".repeat(40) })}\n`); const value = promotion(); value.sourcePrerelease.canaryReceiptSha256 = sha256Bytes(altered); assert.throws(() => verifyStablePromotion(value, { ...options(), read: (path) => path.includes("canary") ? altered : manifestRaw }), /commit drift/); });
test("future canary fails closed", () => { const altered = Buffer.from(`${JSON.stringify({ ...canary, passedAt: "2026-08-19T00:00:00.000Z" })}\n`); const value = promotion(); value.sourcePrerelease.canaryReceiptSha256 = sha256Bytes(altered); assert.throws(() => verifyStablePromotion(value, { ...options(), read: (path) => path.includes("canary") ? altered : manifestRaw }), /timestamp/); });
test("policy paths are immutable code constants", () => { assert.equal(STABLE_PROMOTION_ALLOWED_PATHS.includes("app.js"), false); assert.throws(() => STABLE_PROMOTION_ALLOWED_PATHS.push("app.js")); });
