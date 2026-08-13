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
import { configuredMacs, containerInspectMatchesIdentity, endpointMacs } from "./container-inspect.ts";

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

test("ensureDeviceIdentity tolerates a verified missing temp unlink winner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-id-"));
  const env = path.join(dir, "device-identity.env");
  const seed = generateDeviceIdentity("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  fs.writeFileSync(path.join(dir, "device-identity.json"), JSON.stringify(seed));
  const realUnlink = fs.unlinkSync;
  let removedLinkedTemp = false;
  const unlinkSpy = ((target: fs.PathLike) => {
    const targetPath = String(target);
    if (!removedLinkedTemp && path.basename(targetPath).startsWith("device-identity.env.")) {
      const envStat = fs.statSync(env);
      const tmpStat = fs.statSync(targetPath);
      if (envStat.dev === tmpStat.dev && envStat.ino === tmpStat.ino) {
        removedLinkedTemp = true;
        realUnlink(target);
        const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
    }
    return realUnlink(target);
  }) as typeof fs.unlinkSync;
  fs.unlinkSync = unlinkSpy;
  try {
    assert.deepEqual(ensureDeviceIdentity(dir), seed);
  } finally {
    fs.unlinkSync = realUnlink;
  }
  assert.equal(removedLinkedTemp, true);
  assert.deepEqual(ensureDeviceIdentity(dir), seed);
  assert.equal(fs.statSync(env).nlink, 1);
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

test("container inspect identity check reads Docker endpoint MACs", () => {
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const inspect = JSON.stringify([
    {
      HostConfig: { MacAddress: identity.mac },
      Config: {
        Hostname: identity.hostname,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
      },
      NetworkSettings: {
        Networks: {
          bridge: { MacAddress: identity.mac },
        },
      },
    },
  ]);
  assert.deepEqual(Array.from(endpointMacs(JSON.parse(inspect)[0])), [identity.mac]);
  assert.deepEqual(Array.from(configuredMacs(JSON.parse(inspect)[0])), [identity.mac]);
  assert.equal(containerInspectMatchesIdentity(inspect, identity), true);
  const wrongLiveMac = JSON.stringify([
    {
      ...JSON.parse(inspect)[0],
      NetworkSettings: { Networks: { bridge: { MacAddress: "00:1b:21:00:00:02" } } },
    },
  ]);
  assert.equal(containerInspectMatchesIdentity(wrongLiveMac, identity), false);
  const missing = JSON.stringify([{ Config: JSON.parse(inspect)[0].Config, NetworkSettings: { Networks: { bridge: {} } } }]);
  assert.equal(containerInspectMatchesIdentity(missing, identity), false);
  const ambiguous = JSON.stringify([
    {
      HostConfig: { MacAddress: identity.mac },
      Config: JSON.parse(inspect)[0].Config,
      NetworkSettings: {
        Networks: {
          bridge: { MacAddress: identity.mac },
          other: { MacAddress: "00:1b:21:00:00:02" },
        },
      },
    },
  ]);
  assert.equal(containerInspectMatchesIdentity(ambiguous, identity), false);
  assert.throws(() => containerInspectMatchesIdentity("NOT_JSON", identity));
  assert.throws(() => containerInspectMatchesIdentity("[]", identity));
});

test("container inspect identity check accepts Docker stopped state using configured MAC", () => {
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const inspect = JSON.stringify([
    {
      HostConfig: { MacAddress: identity.mac },
      Config: {
        Hostname: identity.hostname,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
      },
      NetworkSettings: {
        Networks: {
          bridge: { MacAddress: "" },
        },
      },
    },
  ]);
  assert.equal(containerInspectMatchesIdentity(inspect, identity), true);
});

test("container inspect identity check rejects duplicate or missing identity env", () => {
  const identity = generateDeviceIdentity("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const base = {
    HostConfig: { MacAddress: identity.mac },
    Config: {
      Hostname: identity.hostname,
      Env: [
        `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
        `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
        `AGENT_WECHAT_MAC=${identity.mac}`,
      ],
    },
    NetworkSettings: { Networks: { bridge: { MacAddress: identity.mac } } },
  };
  const duplicate = JSON.stringify([
    {
      ...base,
      Config: {
        ...base.Config,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          "AGENT_WECHAT_MACHINE_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
      },
    },
  ]);
  assert.throws(() => containerInspectMatchesIdentity(duplicate, identity), /duplicate AGENT_WECHAT_MACHINE_ID/);

  const missingHostEnv = JSON.stringify([
    {
      ...base,
      Config: {
        ...base.Config,
        Env: [
          `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
          `AGENT_WECHAT_MAC=${identity.mac}`,
        ],
      },
    },
  ]);
  assert.equal(containerInspectMatchesIdentity(missingHostEnv, identity), false);
});

test("cmdUp validates identity before docker start", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf-8");
  const start = src.indexOf("async function cmdUp");
  assert.ok(start >= 0);
  const body = src.slice(start);
  const identityAt = body.indexOf("ensureDeviceIdentity()");
  const inspectAt = body.indexOf("assertExistingContainerMatches");
  const startAt = body.indexOf('["start"');
  assert.ok(identityAt >= 0);
  assert.ok(inspectAt >= 0);
  assert.ok(startAt >= 0);
  assert.ok(identityAt < inspectAt);
  assert.ok(inspectAt < startAt);
});

test("cmdUp treats inspect failure after known container ID as fatal", () => {
  const src = fs.readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf-8");
  assert.match(src, /const existingId = execSync\(`docker ps -aq/);
  assert.doesNotMatch(src, /status === 1[\s\S]*ContainerNotFoundError/);
  const catchAt = src.indexOf("} catch (error) {", src.indexOf("async function cmdUp"));
  const imageInspectAt = src.indexOf("docker image inspect", src.indexOf("async function cmdUp"));
  const catchBody = src.slice(catchAt, imageInspectAt);
  assert.match(catchBody, /if \(!\(error instanceof ContainerNotFoundError\)\)/);
  assert.match(catchBody, /throw error/);
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
