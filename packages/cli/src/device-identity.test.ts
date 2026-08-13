import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { fileURLToPath } from "url";
import {
  buildDockerRunArgs,
  ensureDeviceIdentity,
  generateDeviceIdentity,
  parseDeviceIdentity,
  validHostname,
  validMac,
  validMachineId,
} from "./device-identity.ts";

test("generateDeviceIdentity produces a valid tuple", () => {
  const identity = generateDeviceIdentity(randomBytes(16).toString("hex"));
  assert.equal(parseDeviceIdentity(identity)?.machineId, identity.machineId);
  assert.equal(validMachineId(identity.machineId), true);
  assert.equal(validHostname(identity.hostname), true);
  assert.equal(validMac(identity.mac), true);
});

test("parseDeviceIdentity rejects metacharacters and malformed fields", () => {
  const good = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(parseDeviceIdentity(good)?.hostname, good.hostname);

  assert.equal(parseDeviceIdentity({ ...good, machineId: "$(touch /tmp/pwned)" }), null);
  assert.equal(parseDeviceIdentity({ ...good, machineId: "A".repeat(32) }), null);
  assert.equal(parseDeviceIdentity({ ...good, machineId: "aa" }), null);
  assert.equal(parseDeviceIdentity({ ...good, hostname: "valid; touch /tmp/pwned" }), null);
  assert.equal(parseDeviceIdentity({ ...good, hostname: "host$(reboot)" }), null);
  assert.equal(parseDeviceIdentity({ ...good, hostname: "foo\nbar" }), null);
  assert.equal(parseDeviceIdentity({ ...good, hostname: "" }), null);
  assert.equal(parseDeviceIdentity({ ...good, mac: "01:1b:21:00:00:01" }), null);
  assert.equal(parseDeviceIdentity({ ...good, mac: "00:1b:21:00:00:01;id" }), null);
  assert.equal(parseDeviceIdentity({ hostname: good.hostname, mac: good.mac }), null);
  assert.equal(parseDeviceIdentity("not-json-object"), null);
});

test("ensureDeviceIdentity rejects malicious persisted JSON without docker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  fs.writeFileSync(
    path.join(dir, "device-identity.json"),
    JSON.stringify({
      machineId: "$(touch /tmp/pwned)",
      hostname: "valid; id",
      mac: "00:1b:21:00:00:01",
    }),
  );
  assert.throws(() => ensureDeviceIdentity(dir));
  assert.equal(fs.existsSync(path.join(dir, "device-identity.env")), false);
});

test("ensureDeviceIdentity imports JSON and reuses the env winner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const seed = generateDeviceIdentity("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  fs.writeFileSync(path.join(dir, "device-identity.json"), JSON.stringify(seed));
  assert.deepEqual(ensureDeviceIdentity(dir), seed);
  assert.deepEqual(ensureDeviceIdentity(dir), seed);
});

test("buildDockerRunArgs keeps identity and proxy on argv boundaries", () => {
  const identity = generateDeviceIdentity("ffffffffffffffffffffffffffffffff");
  const args = buildDockerRunArgs(identity, {
    image: "ghcr.io/thisnick/agent-wechat:latest",
    containerName: "agent-wechat",
    tokenPath: "/tmp/token",
    port: 6174,
    proxy: "http://user:p;rm -rf /@evil:8080",
  });
  assert.equal(args.includes(identity.hostname), true);
  assert.equal(args.includes(identity.mac), true);
  assert.equal(args.includes(`AGENT_WECHAT_MAC=${identity.mac}`), true);
  assert.equal(args.includes("PROXY=http://user:p;rm -rf /@evil:8080"), true);
  assert.equal(args.join(" ").includes("docker "), false);
});

test("cmdUp validates identity before docker start", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf-8");
  const start = src.indexOf("async function cmdUp");
  assert.ok(start >= 0);
  const body = src.slice(start);
  const identityAt = body.indexOf("ensureDeviceIdentity()");
  const startAt = body.indexOf("docker start");
  assert.ok(identityAt >= 0);
  assert.ok(startAt >= 0);
  assert.ok(identityAt < startAt);
});

test("ensureDeviceIdentity refuses a dangling identity symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const victim = path.join(dir, "victim.json");
  fs.writeFileSync(victim, "keep\n");
  fs.symlinkSync(victim, path.join(dir, "device-identity.json"));
  assert.throws(() => ensureDeviceIdentity(dir));
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep\n");
});
