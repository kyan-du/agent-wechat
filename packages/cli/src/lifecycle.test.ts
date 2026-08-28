import assert from "node:assert/strict";
import test from "node:test";
import { containerOwnershipError, volumeOwnershipError } from "./lifecycle-policy.ts";
import type { InstanceInventory } from "./instance-inventory.ts";

const inventory: InstanceInventory = {
  schemaVersion: 1,
  containerName: "agent-wechat",
  containerId: "a".repeat(64),
  imageRef: "agent-wechat:arm64",
  port: 6174,
  volumes: ["agent-wechat-data", "agent-wechat-wechat-home"],
  tokenPath: "/tmp/token",
  identityDir: "/tmp",
  identity: { machineId: "a".repeat(32), hostname: "agent-test", mac: "00:1b:21:00:00:01" },
  createdAt: "now",
  updatedAt: "now",
};

const inspect = {
  Id: "a".repeat(64),
  Image: "sha256:" + "b".repeat(64),
  Config: {
    Image: "agent-wechat:arm64",
    Labels: {
      "dev.visionclaw.agent-wechat.instance": "default",
      "dev.visionclaw.agent-wechat.image": "agent-wechat:arm64",
    },
    Hostname: "agent-test",
    Env: [
      `AGENT_WECHAT_MACHINE_ID=${"a".repeat(32)}`,
      "AGENT_WECHAT_HOSTNAME=agent-test",
      "AGENT_WECHAT_MAC=00:1b:21:00:00:01",
    ],
  },
  HostConfig: { PortBindings: { "6174/tcp": [{ HostPort: "6174" }] } },
  Mounts: [
    { Name: "agent-wechat-data", Destination: "/data", Type: "volume" },
    { Name: "agent-wechat-wechat-home", Destination: "/home/wechat", Type: "volume" },
    { Destination: "/data/auth-token", Type: "bind", Source: "/tmp/token" },
  ],
};

test("container actions require exact inventory ownership", () => {
  assert.equal(containerOwnershipError(inspect, inventory), undefined);
  const recreated = { ...inspect, Id: "c".repeat(64) };
  assert.equal(containerOwnershipError(recreated, inventory)?.code, "CONTAINER_ID_MISMATCH");
  assert.equal(containerOwnershipError(recreated, inventory, { ignoreContainerId: true }), undefined);
  const unlabelled = { ...recreated, Config: { ...recreated.Config, Labels: { ...recreated.Config.Labels, ["dev.visionclaw.agent-wechat.instance"]: undefined } } };
  assert.equal(containerOwnershipError(unlabelled, inventory, { ignoreContainerId: true })?.code, "CONTAINER_OWNERSHIP_MISMATCH");
  assert.equal(containerOwnershipError(unlabelled, inventory, { ignoreContainerId: true, allowMissingOwnershipLabel: true }), undefined);
  assert.equal(containerOwnershipError({ ...recreated, Mounts: [] }, inventory, { ignoreContainerId: true })?.code, "CONTAINER_RESOURCE_MISMATCH");
  assert.equal(containerOwnershipError({ ...inspect, Config: { Labels: {} } }, inventory)?.code, "CONTAINER_OWNERSHIP_MISMATCH");
  assert.equal(containerOwnershipError({ ...inspect, Config: { ...inspect.Config, Image: "agent-wechat:amd64" } }, inventory)?.code, "CONTAINER_IMAGE_MISMATCH");
  assert.equal(containerOwnershipError({ ...inspect, Config: { ...inspect.Config, Env: [...inspect.Config.Env, `AGENT_WECHAT_MAC=${inventory.identity.mac}`] } }, inventory)?.code, "CONTAINER_IDENTITY_MISMATCH");
  assert.equal(containerOwnershipError({ ...inspect, Mounts: [] }, inventory)?.code, "CONTAINER_RESOURCE_MISMATCH");
});

test("purge volume scope requires exact labels, driver, and role", () => {
  const owned = {
    Name: "agent-wechat-data",
    Driver: "local",
    Labels: {
      "dev.visionclaw.agent-wechat.instance": "default",
      "dev.visionclaw.agent-wechat.volume-role": "data",
    },
  };
  assert.equal(volumeOwnershipError(owned, "agent-wechat-data", "data"), undefined);
  assert.equal(volumeOwnershipError({ ...owned, Labels: {} }, "agent-wechat-data", "data")?.code, "VOLUME_OWNERSHIP_MISMATCH");
  assert.equal(volumeOwnershipError({ ...owned, Driver: "custom" }, "agent-wechat-data", "data")?.code, "VOLUME_OWNERSHIP_MISMATCH");
  assert.equal(volumeOwnershipError(owned, "agent-wechat-wechat-home", "wechat-home")?.code, "VOLUME_OWNERSHIP_MISMATCH");
});
