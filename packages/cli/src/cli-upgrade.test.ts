import assert from "node:assert/strict";
import test from "node:test";
import { checkCliUpgrade, CliUpgradeError } from "./cli-upgrade.ts";

test("offers exact global command from prerelease to stable", () => {
  assert.deepEqual(checkCliUpgrade("0.12.0-next.0", () => '"0.12.0"\n'), {
    currentVersion: "0.12.0-next.0",
    latestVersion: "0.12.0",
    updateAvailable: true,
    command: "npm install --global @kyan-du/agent-wechat-cli@0.12.0",
  });
});

test("reports already latest without an install command", () => {
  assert.deepEqual(checkCliUpgrade("0.12.0", () => '"0.12.0"'), {
    currentVersion: "0.12.0",
    latestVersion: "0.12.0",
    updateAvailable: false,
  });
});

test("does not offer a downgrade", () => {
  assert.deepEqual(checkCliUpgrade("0.13.0", () => '"0.12.0"'), {
    currentVersion: "0.13.0",
    latestVersion: "0.12.0",
    updateAvailable: false,
  });
});

test("maps registry failures to a stable CLI error", () => {
  assert.throws(() => checkCliUpgrade("0.12.0", () => { throw new Error("offline"); }), (error) => {
    assert.ok(error instanceof CliUpgradeError);
    assert.equal(error.code, "CLI_UPGRADE_REGISTRY_ERROR");
    return true;
  });
});

test("rejects a prerelease latest dist-tag", () => {
  assert.throws(() => checkCliUpgrade("0.12.0", () => '"0.13.0-next.0"'), (error) => {
    assert.ok(error instanceof CliUpgradeError);
    assert.equal(error.code, "CLI_UPGRADE_PRERELEASE_REJECTED");
    return true;
  });
});

test("rejects malformed or injectable latest versions", () => {
  for (const latest of ['"0.12.0; touch /tmp/pwned"', '"v0.12.0"', '{"version":"0.12.0"}', '"1.2.03"']) {
    assert.throws(() => checkCliUpgrade("0.12.0-next.0", () => latest), (error) => {
      assert.ok(error instanceof CliUpgradeError);
      assert.equal(error.code, "CLI_UPGRADE_INVALID_VERSION");
      return true;
    });
  }
});
