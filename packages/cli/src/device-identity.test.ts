import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { fileURLToPath } from "url";
import {
  buildDockerRunArgs,
  ensureDeviceIdentity,
  exclusivePublish,
  generateDeviceIdentity,
  parseDeviceIdentity,
  validHostname,
  validMac,
  validMachineId,
} from "./device-identity.ts";
import {
  bindExistingContainer,
  containerInspectMatchesIdentity,
  endpointMacs,
  parseExactlyOneDockerId,
} from "./container-inspect.ts";

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

test("ensureDeviceIdentity recovers two same-inode temp remnants", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const env = path.join(dir, "device-identity.env");
  const seed = generateDeviceIdentity("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  fs.writeFileSync(
    env,
    [
      `AGENT_WECHAT_MACHINE_ID=${seed.machineId}`,
      `AGENT_WECHAT_HOSTNAME=${seed.hostname}`,
      `AGENT_WECHAT_MAC=${seed.mac}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.linkSync(env, path.join(dir, "device-identity.env.one"));
  fs.linkSync(env, path.join(dir, "device-identity.env.two"));
  assert.equal(fs.statSync(env).nlink, 3);
  assert.deepEqual(ensureDeviceIdentity(dir), seed);
  assert.equal(fs.statSync(env).nlink, 1);
  assert.equal(fs.existsSync(path.join(dir, "device-identity.env.one")), false);
  assert.equal(fs.existsSync(path.join(dir, "device-identity.env.two")), false);
});

test("ensureDeviceIdentity recovers a committed env with an owned temp hard link", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const env = path.join(dir, "device-identity.env");
  const tmp = path.join(dir, `device-identity.env.${process.pid}.abcd1234`);
  const seed = generateDeviceIdentity("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  fs.writeFileSync(
    env,
    [
      `AGENT_WECHAT_MACHINE_ID=${seed.machineId}`,
      `AGENT_WECHAT_HOSTNAME=${seed.hostname}`,
      `AGENT_WECHAT_MAC=${seed.mac}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.linkSync(env, tmp);
  assert.equal(fs.statSync(env).nlink, 2);
  assert.deepEqual(ensureDeviceIdentity(dir), seed);
  assert.equal(fs.statSync(env).nlink, 1);
  assert.equal(fs.existsSync(tmp), false);
});

test("ensureDeviceIdentity rejects non-ascii persisted env bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const payload = Buffer.from(
    "AGENT_WECHAT_MACHINE_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAGENT_WECHAT_HOSTNAME=lenovo-pc-100\nAGENT_WECHAT_MAC=00:1b:21:00:00:01\n",
    "ascii",
  );
  payload[payload.length - 3] = 0xb1;
  fs.writeFileSync(path.join(dir, "device-identity.env"), payload);
  assert.throws(() => ensureDeviceIdentity(dir), /non-ascii identity/);
});

test("buildDockerRunArgs keeps identity and proxy on argv boundaries", () => {
  const identity = generateDeviceIdentity("ffffffffffffffffffffffffffffffff");
  const args = buildDockerRunArgs(identity, {
    image: "ghcr.io/kyan-du/agent-wechat:0.11.15",
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

function inspectFixture(
  identity: ReturnType<typeof generateDeviceIdentity>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify([
    {
      Config: {
        Hostname: identity.hostname,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
        ...((extra.Config as object) ?? {}),
      },
      HostConfig: extra.HostConfig,
      NetworkSettings: extra.NetworkSettings ?? {
        Networks: { bridge: { MacAddress: identity.mac } },
      },
    },
  ]);
}

test("container inspect uses durable env MAC when endpoints are empty (stopped)", () => {
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const running = inspectFixture(identity);
  assert.deepEqual(endpointMacs(JSON.parse(running)[0]), [identity.mac]);
  assert.equal(containerInspectMatchesIdentity(running, identity), true);

  const stopped = inspectFixture(identity, {
    NetworkSettings: { MacAddress: "", Networks: { bridge: { MacAddress: "" } } },
  });
  assert.deepEqual(endpointMacs(JSON.parse(stopped)[0]), []);
  assert.equal(containerInspectMatchesIdentity(stopped, identity), true);

  const wrongEnv = inspectFixture(identity).replace(
    `AGENT_WECHAT_MAC=${identity.mac}`,
    "AGENT_WECHAT_MAC=00:1b:21:00:00:02",
  );
  assert.equal(containerInspectMatchesIdentity(wrongEnv, identity), false);

  const wrongLive = inspectFixture(identity, {
    NetworkSettings: { Networks: { bridge: { MacAddress: "00:1b:21:00:00:02" } } },
  });
  assert.equal(containerInspectMatchesIdentity(wrongLive, identity), false);

  const ambiguous = inspectFixture(identity, {
    NetworkSettings: {
      Networks: {
        bridge: { MacAddress: identity.mac },
        other: { MacAddress: "00:1b:21:00:00:02" },
      },
    },
  });
  assert.equal(containerInspectMatchesIdentity(ambiguous, identity), false);

  const missingEnv = JSON.stringify([
    {
      Config: { Hostname: identity.hostname, Env: [`AGENT_WECHAT_MACHINE_ID=${identity.machineId}`] },
      NetworkSettings: { Networks: { bridge: { MacAddress: "" } } },
    },
  ]);
  assert.throws(() => containerInspectMatchesIdentity(missingEnv, identity), /missing AGENT_WECHAT_HOSTNAME/);

  const dupParsed = JSON.parse(inspectFixture(identity));
  dupParsed[0].Config.Env.unshift("AGENT_WECHAT_MACHINE_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.throws(
    () => containerInspectMatchesIdentity(JSON.stringify(dupParsed), identity),
    /duplicate AGENT_WECHAT_MACHINE_ID/,
  );

  assert.throws(() => containerInspectMatchesIdentity("NOT_JSON", identity));
  assert.throws(() => containerInspectMatchesIdentity("[]", identity));
});

test("bindExistingContainer binds ps/inspect/running to one id", () => {
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const id = "a".repeat(64);
  const other = "b".repeat(64);
  const raw = JSON.stringify([
    {
      Id: id,
      Config: {
        Hostname: identity.hostname,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
      },
      NetworkSettings: { MacAddress: "", Networks: { bridge: { MacAddress: "" } } },
    },
  ]);
  assert.equal(parseExactlyOneDockerId(`${id}\n`), id);
  assert.throws(() => parseExactlyOneDockerId(`${id}\n${other}\n`));
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: `${id}\n${other}\n`,
      psRunningRaw: "",
      inspectOk: true,
      inspectRaw: raw,
      identity,
    }),
    { action: "fail", reason: "ambiguous-id" },
  );
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: id,
      psRunningRaw: "",
      inspectOk: false,
      identity,
    }),
    { action: "fail", reason: "inspect-failed" },
  );
  const mismatch = JSON.stringify([{ ...JSON.parse(raw)[0], Id: other }]);
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: id,
      psRunningRaw: "",
      inspectOk: true,
      inspectRaw: mismatch,
      identity,
    }),
    { action: "fail", reason: "id-mismatch" },
  );
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: id,
      psRunningRaw: other,
      inspectOk: true,
      inspectRaw: raw,
      identity,
    }),
    { action: "fail", reason: "id-mismatch" },
  );
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: id,
      psRunningRaw: "",
      inspectOk: true,
      inspectRaw: raw,
      identity,
    }),
    { action: "use-existing", id, start: true },
  );
  assert.deepEqual(
    bindExistingContainer({
      psAllRaw: id,
      psRunningRaw: id,
      inspectOk: true,
      inspectRaw: raw,
      identity,
    }),
    { action: "use-existing", id, start: false },
  );
});

test("exclusivePublish survives remnant cleanup of its temp link", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const env = path.join(dir, "device-identity.env");
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(
    exclusivePublish(env, identity, {
      afterLink: (tmp) => fs.unlinkSync(tmp),
    }),
    true,
  );
  assert.deepEqual(ensureDeviceIdentity(dir), identity);
});

test("cmdUp validates identity before docker start", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf-8");
  const start = src.indexOf("async function cmdUp");
  assert.ok(start >= 0);
  const body = src.slice(start);
  const identityAt = body.indexOf("ensureDeviceIdentity()");
  const inspectAt = body.indexOf("bindExistingContainer");
  const startAt = body.indexOf('["start"');
  assert.ok(identityAt >= 0);
  assert.ok(inspectAt >= 0);
  assert.ok(startAt >= 0);
  assert.ok(identityAt < inspectAt);
  assert.ok(inspectAt < startAt);
  assert.equal(body.includes("ContainerNotFoundError"), false);
});

test("ensureDeviceIdentity ignores inherited env when creating a second dir", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const first = ensureDeviceIdentity(a);
  process.env.AGENT_WECHAT_MACHINE_ID = first.machineId;
  process.env.AGENT_WECHAT_HOSTNAME = first.hostname;
  process.env.AGENT_WECHAT_MAC = first.mac;
  const second = ensureDeviceIdentity(b);
  assert.notEqual(second.machineId, first.machineId);
});

test("ensureDeviceIdentity refuses a dangling identity symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const victim = path.join(dir, "victim.json");
  fs.writeFileSync(victim, "keep\n");
  fs.symlinkSync(victim, path.join(dir, "device-identity.json"));
  assert.throws(() => ensureDeviceIdentity(dir));
  assert.equal(fs.readFileSync(victim, "utf-8"), "keep\n");
});

test("stopped docker container with create-time MAC still matches", (t) => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    t.skip("docker is not available");
    return;
  }
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const name = `wx-id-test-${process.pid}`;
  try {
    execFileSync(
      "docker",
      [
        "create",
        "--name",
        name,
        "--hostname",
        identity.hostname,
        "--mac-address",
        identity.mac,
        "-e",
        `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
        "-e",
        `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
        "-e",
        `AGENT_WECHAT_MAC=${identity.mac}`,
        "alpine:3.20",
        "true",
      ],
      { stdio: "ignore" },
    );
    const created = execFileSync("docker", ["inspect", name], { encoding: "utf-8" });
    assert.equal(containerInspectMatchesIdentity(created, identity), true);
    execFileSync("docker", ["start", name], { stdio: "ignore" });
    const running = execFileSync("docker", ["inspect", name], { encoding: "utf-8" });
    assert.equal(containerInspectMatchesIdentity(running, identity), true);
    execFileSync("docker", ["stop", "-t", "0", name], { stdio: "ignore" });
    const stopped = execFileSync("docker", ["inspect", name], { encoding: "utf-8" });
    assert.equal(containerInspectMatchesIdentity(stopped, identity), true);
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // cleanup
    }
  }
});
