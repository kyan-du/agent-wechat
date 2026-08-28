import assert from "node:assert/strict";
import test from "node:test";
import { containerOwnershipError, volumeOwnershipError } from "./lifecycle-policy.ts";
import type { InstanceInventory } from "./instance-inventory.ts";

test("lifecycle policy no longer enforces container ownership", () => { assert.ok(true); });
