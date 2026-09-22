import assert from "node:assert/strict";
import test from "node:test";
import { INSTANCE_LABEL, VOLUME_ROLE_LABEL, sameFixedInstance, type VolumeInspect } from "./lifecycle-policy.ts";

const names = ["agent-wechat-data", "agent-wechat-wechat-home"] as const;
const inventory = { containerName: "agent-wechat", volumes: [...names] };

function volume(name: string, role: "data" | "wechat-home"): VolumeInspect {
  return { Name: name, Driver: "local", Labels: { [INSTANCE_LABEL]: "default", [VOLUME_ROLE_LABEL]: role } };
}

function mounts(entries: Array<{ Name?: string; Destination: string; Type: string }>) {
  return entries;
}

const owned = [volume(names[0], "data"), volume(names[1], "wechat-home")] as [VolumeInspect, VolumeInspect];
const attached = mounts([
  { Name: names[0], Destination: "/data", Type: "volume" },
  { Name: names[1], Destination: "/home/wechat", Type: "volume" },
]);

test("the live container must mount both owned volumes at the instance paths", () => {
  assert.equal(sameFixedInstance({ containerName: "agent-wechat", volumes: owned, mounts: attached, inventory }), true);
});

test("a namesake that bind-mounts those paths is not this instance", () => {
  const binds = mounts([
    { Destination: "/data", Type: "bind" },
    { Destination: "/home/wechat", Type: "bind" },
  ]);
  assert.equal(sameFixedInstance({ containerName: "agent-wechat", volumes: owned, mounts: binds, inventory }), false);
});

test("swapped volume destinations are not this instance", () => {
  const swapped = mounts([
    { Name: names[1], Destination: "/data", Type: "volume" },
    { Name: names[0], Destination: "/home/wechat", Type: "volume" },
  ]);
  assert.equal(sameFixedInstance({ containerName: "agent-wechat", volumes: owned, mounts: swapped, inventory }), false);
});

test("missing mounts are not this instance", () => {
  assert.equal(sameFixedInstance({ containerName: "agent-wechat", volumes: owned, mounts: undefined, inventory }), false);
});

test("an unlabeled host volume is not this instance", () => {
  const unlabeled: VolumeInspect = { Name: names[0], Driver: "local", Labels: {} };
  assert.equal(sameFixedInstance({
    containerName: "agent-wechat",
    volumes: [unlabeled, owned[1]],
    mounts: attached,
    inventory,
  }), false);
});
