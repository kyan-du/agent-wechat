import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const cli = fs.readFileSync(path.join(import.meta.dirname, "cli.ts"), "utf8");

test("restart stops a running old container before renaming it or starting replacement", () => {
  const restart = cli.slice(cli.indexOf('program.command("restart")'), cli.indexOf('program.command("status")'));
  const stop = restart.indexOf("stopContainer(oldContainer.Id)");
  const rename = restart.indexOf("renameContainer(oldContainer.Id, rollbackName)");
  const start = restart.indexOf("startInstance({");
  assert.ok(stop >= 0 && rename >= 0 && start >= 0);
  assert.ok(stop < rename, "old container must stop before rename");
  assert.ok(rename < start, "replacement must start after old container is moved aside");
  assert.match(restart, /oldContainer\.State\?\.Running\) \{ stopContainer\(oldContainer\.Id\);/);
});

test("restart rollback restores inventory and the old running state", () => {
  const restart = cli.slice(cli.indexOf('program.command("restart")'), cli.indexOf('program.command("status")'));
  assert.ok(restart.indexOf("saveInventory(previousInventory)") > restart.indexOf("renameContainer(rollbackName, CONTAINER_NAME)"));
  assert.match(restart, /oldStopped && oldContainer\.State\?\.Running\) startContainer\(CONTAINER_NAME\)/);
});
