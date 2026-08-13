import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "crypto";
import {
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
