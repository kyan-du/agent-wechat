#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [cli, stage] = process.argv.slice(2);
if (!cli || !stage) throw new Error("usage: test-packed-cli-health.mjs <cli> <stage>");
const home = path.join(stage, "health-home");
const config = path.join(home, ".config", "agent-wechat");
const bin = path.join(stage, "health-bin");
fs.mkdirSync(config, { recursive: true, mode: 0o700 });
fs.mkdirSync(bin, { recursive: true });
const id = "a".repeat(64);
const identity = { machineId: "b".repeat(32), hostname: "agent-test", mac: "00:1b:21:00:00:01" };
const tokenPath = path.join(config, "token");
fs.writeFileSync(tokenPath, `${"c".repeat(64)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(config, "instance.json"), `${JSON.stringify({
  schemaVersion: 1,
  containerName: "agent-wechat",
  containerId: id,
  imageRef: "agent-wechat:arm64",
  port: 6174,
  volumes: ["agent-wechat-data", "agent-wechat-wechat-home"],
  tokenPath,
  identityDir: config,
  identity,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}, null, 2)}\n`, { mode: 0o600 });
const inspect = JSON.stringify([{
  Id: id,
  Config: {
    Image: "agent-wechat:arm64",
    Labels: {
      "dev.visionclaw.agent-wechat.instance": "default",
      "dev.visionclaw.agent-wechat.image": "agent-wechat:arm64",
    },
    Hostname: identity.hostname,
    Env: [
      `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
      `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
      `AGENT_WECHAT_MAC=${identity.mac}`,
    ],
  },
  HostConfig: { PortBindings: { "6174/tcp": [{ HostPort: "6174" }] } },
  State: { Running: true },
  Mounts: [
    { Name: "agent-wechat-data", Destination: "/data", Type: "volume" },
    { Name: "agent-wechat-wechat-home", Destination: "/home/wechat", Type: "volume" },
    { Destination: "/data/auth-token", Type: "bind", Source: tokenPath },
  ],
}]);
const docker = path.join(bin, "docker");
fs.writeFileSync(docker, `#!/bin/sh\ncase "$1" in\n  info) exit 0 ;;\n  ps) printf '%s\\n' '${id}' ;;\n  inspect) cat '${path.join(stage, "inspect.json")}' ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
fs.writeFileSync(path.join(stage, "inspect.json"), inspect);
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AGENT_WECHAT_URL: "http://127.0.0.1:6174" };

async function run(command) {
  const child = spawn(process.execPath, [cli, "--json", command], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => child.once("error", reject).once("close", resolve));
  assert.equal(stderr, "");
  const body = JSON.parse(stdout);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, false);
  return { status, body };
}

let probe = await run("status");
assert.equal(probe.status, 4);
assert.equal(probe.body.code, "SERVER_UNREACHABLE");

let mode = "incompatible";
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/health") return response.end('{"status":"ok"}');
  if (request.url === "/api/status") return response.end(JSON.stringify({ container: "running", loginState: { status: "logged_out" }, version: "test", apiVersion: mode === "incompatible" ? 2 : 1 }));
  if (request.url === "/api/status/auth") {
    response.statusCode = 500;
    return response.end('{"errorCode":"AUTH_PROBE_TEST"}');
  }
  response.statusCode = 404;
  response.end("{}");
});
await new Promise((resolve, reject) => server.listen(6174, "127.0.0.1", resolve).once("error", reject));
try {
  probe = await run("status");
  assert.equal(probe.status, 4);
  assert.equal(probe.body.code, "IMAGE_API_INCOMPATIBLE");
  mode = "auth";
  probe = await run("status");
  assert.equal(probe.status, 4);
  assert.equal(probe.body.code, "AUTH_PROBE_FAILED");
  probe = await run("doctor");
  assert.equal(probe.status, 4);
  assert.equal(probe.body.code, "AUTH_PROBE_FAILED");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Packed CLI unhealthy prerequisite journeys passed.");
