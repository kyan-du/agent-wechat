import assert from "node:assert/strict";
import test from "node:test";
import { localBuildImage, migrateSessionImage, validateImageReference } from "./image.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSession, getSessionPath, loadSession, saveSession, type SessionConfig } from "./session.ts";

function persistedSession(dataDir: string, image: string): SessionConfig {
  const sessionDir = path.join(dataDir, "sessions", "default");
  return {
    name: "default",
    containerName: "agent-wechat-default",
    image,
    dataDir: sessionDir,
    downloadsDir: path.join(sessionDir, "downloads"),
    wechatConfigDir: path.join(sessionDir, "wechat-config"),
    wechatDataDir: path.join(sessionDir, "wechat-data"),
  };
}

test("default image is the local architecture build", () => {
  assert.equal(localBuildImage("darwin", "arm64"), "agent-wechat:arm64");
  assert.equal(localBuildImage("linux", "x64"), "agent-wechat:amd64");
});

test("root CLI pulls only an absent explicit fork tag or digest with Docker argv", () => {
  const cli = fs.readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  assert.match(cli, /execDocker\(\["pull", image\]/);
  assert.match(cli, /typeof flags\.image === "string"/);
  assert.match(cli, /no latest or alternate-registry fallback/);
  assert.doesNotMatch(cli, /exec(?:Sync)?\(`docker pull/);
});

test("stale known session defaults migrate locally while arbitrary values fail", () => {
  assert.deepEqual(migrateSessionImage("ghcr.io/agent-wechat/agent-wechat:latest"), { image: localBuildImage(), migrated: true });
  assert.deepEqual(migrateSessionImage("ghcr.io/kyan-du/agent-wechat:latest"), { image: localBuildImage(), migrated: true });
  assert.deepEqual(migrateSessionImage("ghcr.io/thisnick/agent-wechat:0.11.15"), { image: localBuildImage(), migrated: true });
  assert.throws(() => migrateSessionImage("evil.example/image:7"), /Invalid image reference/);
});

test("loadSession migrates the exact historical root-CLI default and persists the controlled local image", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wechat-session-"));
  try {
    saveSession(dataDir, "default", persistedSession(dataDir, "ghcr.io/agent-wechat/agent-wechat:latest"));
    assert.equal(loadSession(dataDir, "default")?.image, localBuildImage());
    assert.equal(JSON.parse(fs.readFileSync(getSessionPath(dataDir, "default"), "utf8")).image, localBuildImage());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ensureSession validates and applies an explicit image before recovering an unsafe persisted image", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wechat-session-"));
  const explicit = "ghcr.io/kyan-du/agent-wechat:1.2.3";
  try {
    saveSession(dataDir, "default", persistedSession(dataDir, "evil.example/image:latest"));
    assert.equal(ensureSession(dataDir, "default", { image: explicit }).image, explicit);
    assert.equal(loadSession(dataDir, "default")?.image, explicit);
    assert.throws(() => ensureSession(dataDir, "default", { image: "ghcr.io/kyan-du/agent-wechat:latest" }), /Invalid image reference/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("accepts local images and explicit immutable release selections", () => {
  assert.equal(validateImageReference("agent-wechat:arm64"), "agent-wechat:arm64");
  assert.equal(validateImageReference("ghcr.io/kyan-du/agent-wechat:1.2.3"), "ghcr.io/kyan-du/agent-wechat:1.2.3");
  const digest = `ghcr.io/kyan-du/agent-wechat@sha256:${"a".repeat(64)}`;
  assert.equal(validateImageReference(digest), digest);
});

test("rejects dead defaults, latest, foreign, placeholders, and shell-like values", () => {
  for (const reference of [
    "ghcr.io/kyan-du/agent-wechat:latest",
    "ghcr.io/other/image:1.2.3",
    "ghcr.io/kyan-du/agent-wechat:<version>",
    "agent-wechat:arm64;echo pwned",
  ]) {
    assert.throws(() => validateImageReference(reference), /Invalid image reference/);
  }
});
