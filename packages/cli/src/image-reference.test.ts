import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { localBuildImage, validatePublishedImageReference } from "./image-reference.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = fs.readFileSync(path.join(repo, "packages/cli/src/cli.ts"), "utf8");

test("accepts exact fork semver tags and sha256 digests", () => {
  const tag = "ghcr.io/kyan-du/agent-wechat:1.2.3-rc.1";
  const digest = `ghcr.io/kyan-du/agent-wechat@sha256:${"a".repeat(64)}`;
  assert.equal(validatePublishedImageReference(tag), tag);
  assert.equal(validatePublishedImageReference(digest), digest);
});

test("rejects floating, foreign, malformed, and shell-like image references", () => {
  for (const value of [
    "ghcr.io/kyan-du/agent-wechat:latest",
    "ghcr.io/other/image:1.2.3",
    "ghcr.io/kyan-du/agent-wechat:<version>",
    `ghcr.io/kyan-du/agent-wechat@sha256:${"A".repeat(64)}`,
    "ghcr.io/kyan-du/agent-wechat:1.2.3;touch /tmp/pwned",
  ]) assert.throws(() => validatePublishedImageReference(value), /Invalid image reference/);
});

test("default CLI path selects a usable local build and never falls back to a registry tag", () => {
  assert.equal(localBuildImage("darwin", "arm64"), "agent-wechat:arm64");
  assert.equal(localBuildImage("linux", "x64"), "agent-wechat:amd64");
  assert.doesNotMatch(cli, /return `\$\{GHCR_IMAGE\}:\$\{VERSION\}`/);
  assert.match(cli, /opts\.image \? validatePublishedImageReference\(opts\.image\) : getImageTag\(\)/);
});

test("Docker operations preserve the selected image as one argv value", () => {
  assert.match(cli, /execFileSync\("docker", \["image", "inspect", image\]/);
  assert.match(cli, /execFileSync\("docker", \["pull", image\]/);
  assert.doesNotMatch(cli, /execSync\(`docker (?:pull|image inspect) \$\{image\}`/);
});

test("checked-in Compose release boundary uses the local build image", () => {
  const compose = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8");
  assert.match(compose, /^\s*image: agent-wechat:\$\{AGENT_WECHAT_ARCH:-amd64\}$/m);
  assert.doesNotMatch(compose, /<version>|ghcr\.io\/kyan-du/);
  const rendered = execFileSync("docker", ["compose", "-f", path.join(repo, "docker-compose.yml"), "config"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AGENT_WECHAT_MACHINE_ID: "a".repeat(32),
      AGENT_WECHAT_HOSTNAME: "agent-wechat-test",
      AGENT_WECHAT_MAC: "00:1b:21:00:00:01",
    },
  });
  assert.match(rendered, /image: agent-wechat:amd64/);
  assert.doesNotMatch(rendered, /ghcr\.io|<version>/);
});

test("changeset config generates future changelog links with fork identity", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repo, ".changeset/config.json"), "utf8"));
  assert.deepEqual(config.changelog, ["@changesets/changelog-github", { repo: "kyan-du/agent-wechat" }]);
  for (const group of config.fixed) for (const name of group) assert.match(name, /^@kyan-du\/agent-wechat-/);
});
