import assert from "node:assert/strict";
import test from "node:test";
import { classifyGithubRelease, queryGithubRelease } from "./github-release-state.mjs";

const manifest = { tag: "v1.2.3", commit: "1".repeat(40), manifestSha256: `sha256:${"2".repeat(64)}` };
const exact = { id: "R_1", tagName: manifest.tag, targetCommitish: manifest.commit, name: manifest.tag, isDraft: false, isPrerelease: false, body: `notes\nAgent-Release-Manifest-SHA256: ${manifest.manifestSha256}`, assets: [], url: "https://example/release" };
test("missing exact tag is absent only for the authenticated gh not-found shape", () => {
  assert.deepEqual(classifyGithubRelease(manifest, { status: 1, stdout: "", stderr: "release not found\n" }), { state: "absent" });
  assert.throws(() => classifyGithubRelease(manifest, { status: 1, stdout: "{}", stderr: "release not found\n" }), /failed closed/);
});
test("exact final Release is a no-op recovery state", () => assert.equal(classifyGithubRelease(manifest, { status: 0, stdout: JSON.stringify(exact), stderr: "" }).state, "exact"));
for (const [name, mutation] of [
  ["target", { targetCommitish: "main" }], ["prerelease", { isPrerelease: true }], ["draft", { isDraft: true }],
  ["title", { name: "wrong" }], ["tag", { tagName: "v1.2.4" }], ["manifest", { body: "wrong" }], ["assets", { assets: [{ name: "unknown" }] }],
]) test(`${name} drift fails closed`, () => assert.equal(classifyGithubRelease(manifest, { status: 0, stdout: JSON.stringify({ ...exact, ...mutation }), stderr: "" }).state, "drift"));
test("malformed and API failures fail closed", () => {
  assert.throws(() => classifyGithubRelease(manifest, { status: 0, stdout: "{", stderr: "" }), /malformed/);
  assert.throws(() => classifyGithubRelease(manifest, { status: 2, stdout: "", stderr: "network" }), /failed closed/);
  assert.throws(() => classifyGithubRelease(manifest, { status: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n" }), /failed closed/);
});
test("query uses exact tag and complete identity fields", () => {
  const calls = [];
  const state = queryGithubRelease(manifest, (command, args) => { calls.push({ command, args }); return { status: 0, stdout: JSON.stringify(exact), stderr: "" }; });
  assert.equal(state.state, "exact");
  assert.deepEqual(calls[0].args.slice(0, 3), ["release", "view", manifest.tag]);
  assert.match(calls[0].args.at(-1), /targetCommitish/);
});
