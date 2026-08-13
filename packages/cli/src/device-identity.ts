/** Same machine-id / hostname / MAC rules as scripts/device_identity.py. */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type DeviceIdentity = {
  machineId: string;
  hostname: string;
  mac: string;
};

const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const PREFIXES = ["lenovo-pc", "honor-pc", "xiaomi-pc", "asus-pc", "dell-pc", "hp-pc", "thinkpad"];

function hasLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

export function validMachineId(value: string): boolean {
  return !hasLineBreak(value) && MACHINE_ID_RE.test(value);
}

export function validHostname(value: string): boolean {
  return (
    !hasLineBreak(value) &&
    value.length >= 1 &&
    value.length <= 63 &&
    HOSTNAME_RE.test(value)
  );
}

export function validMac(value: string): boolean {
  if (hasLineBreak(value) || !MAC_RE.test(value)) return false;
  return parseInt(value.slice(0, 2), 16) % 2 === 0;
}

export function parseDeviceIdentity(raw: unknown): DeviceIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.machineId !== "string" || !validMachineId(rec.machineId)) return null;
  if (typeof rec.hostname !== "string" || !validHostname(rec.hostname)) return null;
  if (typeof rec.mac !== "string" || !validMac(rec.mac)) return null;
  return { machineId: rec.machineId, hostname: rec.hostname, mac: rec.mac };
}

export function generateDeviceIdentity(machineId: string): DeviceIdentity {
  const prefix = PREFIXES[parseInt(machineId.slice(0, 2), 16) % PREFIXES.length];
  const num = (parseInt(machineId.slice(2, 6), 16) % 900) + 100;
  const identity: DeviceIdentity = {
    machineId,
    hostname: `${prefix}-${num}`,
    mac: ["00", "1b", "21", machineId.slice(6, 8), machineId.slice(8, 10), machineId.slice(10, 12)].join(":"),
  };
  if (!parseDeviceIdentity(identity)) {
    throw new Error("generated device identity failed validation");
  }
  return identity;
}

export function resolveIdentityGenerator(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "device_identity.py"),
    path.join(here, "../scripts/device_identity.py"),
    path.join(here, "../../../scripts/device_identity.py"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("device_identity.py not found");
}

function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

export function parseIdentityExports(output: string): DeviceIdentity | null {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    env[match[1]] = unquote(match[2]);
  }
  return parseDeviceIdentity({
    machineId: env.AGENT_WECHAT_MACHINE_ID,
    hostname: env.AGENT_WECHAT_HOSTNAME,
    mac: env.AGENT_WECHAT_MAC,
  });
}

/** Serialized first-run via the canonical Python generator (fcntl + env file). */
export function ensureDeviceIdentity(dir: string): DeviceIdentity {
  const out = execFileSync("python3", [resolveIdentityGenerator(), dir], {
    encoding: "utf-8",
  });
  const identity = parseIdentityExports(out);
  if (!identity) {
    throw new Error("identity generator returned an invalid tuple");
  }
  return identity;
}

export function buildDockerRunArgs(
  identity: DeviceIdentity,
  opts: {
    image: string;
    containerName: string;
    tokenPath: string;
    port: number;
    proxy?: string;
  },
): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    opts.containerName,
    "--hostname",
    identity.hostname,
    "--mac-address",
    identity.mac,
    "--security-opt",
    "seccomp=unconfined",
    "--cap-add=SYS_PTRACE",
    "--cap-add=NET_ADMIN",
    "-p",
    `${opts.port}:${opts.port}`,
    "-v",
    `${opts.containerName}-data:/data`,
    "-v",
    `${opts.containerName}-wechat-home:/home/wechat`,
    "-v",
    `${opts.tokenPath}:/data/auth-token:ro`,
    "-e",
    `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
    "-e",
    `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
    "-e",
    `AGENT_WECHAT_MAC=${identity.mac}`,
  ];
  if (opts.proxy) {
    args.push("-e", `PROXY=${opts.proxy}`);
  }
  args.push(opts.image);
  return args;
}
