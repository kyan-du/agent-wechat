/** Same machine-id / hostname / MAC store as scripts/device_identity.py. No host Python. */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

export type DeviceIdentity = {
  machineId: string;
  hostname: string;
  mac: string;
};

const MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const PREFIXES = ["lenovo-pc", "honor-pc", "xiaomi-pc", "asus-pc", "dell-pc", "hp-pc", "thinkpad"];
const ENV_NAME = "device-identity.env";
const JSON_NAME = "device-identity.json";
const ENV_TEMP_RE = /^device-identity\.env\.(?:\d+\.[0-9a-f]{8}|[A-Za-z0-9_-]+)$/;

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

type PathKind = "absent" | "symlink" | "file" | "dir" | "other";

function pathKind(target: string): PathKind {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

function requireAbsentOrRegular(target: string): void {
  const kind = pathKind(target);
  if (kind === "symlink") throw new Error(`${target} is a symlink`);
  if (kind === "other" || kind === "dir") throw new Error(`${target} is not a regular file`);
}

function hardenRegular(target: string): void {
  requireAbsentOrRegular(target);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(target, flags);
  try {
    let st = fs.fstatSync(fd);
    if (st.nlink > 1) {
      cleanupOwnedTempLinks(target, st);
      st = fs.fstatSync(fd);
    }
    if (st.nlink !== 1) throw new Error(`${target} has unexpected link count ${st.nlink}`);
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (uid !== 0 && st.uid !== uid) {
        throw new Error(`${target} is not owned by the current user`);
      }
    }
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function cleanupOwnedTempLinks(target: string, targetStat: fs.Stats): void {
  const dir = path.dirname(target);
  const base = path.basename(target);
  for (const name of fs.readdirSync(dir)) {
    if (name === base || !ENV_TEMP_RE.test(name)) continue;
    const candidate = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (
      st.isFile() &&
      st.dev === targetStat.dev &&
      st.ino === targetStat.ino &&
      st.nlink === targetStat.nlink
    ) {
      fs.unlinkSync(candidate);
    }
  }
}

function parseEnvFile(target: string): DeviceIdentity {
  requireAbsentOrRegular(target);
  const data = fs.readFileSync(target);
  if (data.includes(0)) throw new Error(`NUL in ${target}`);
  if (data.some((byte) => byte > 0x7f)) throw new Error(`non-ascii identity in ${target}`);
  const text = data.toString("utf-8");
  let machineId: string | undefined;
  let hostname: string | undefined;
  let mac: string | undefined;
  for (const line of text.split(/\n/)) {
    if (line === "") continue;
    if (line.startsWith("AGENT_WECHAT_MACHINE_ID=")) {
      if (machineId) throw new Error(`duplicate AGENT_WECHAT_MACHINE_ID in ${target}`);
      machineId = line.slice("AGENT_WECHAT_MACHINE_ID=".length);
    } else if (line.startsWith("AGENT_WECHAT_HOSTNAME=")) {
      if (hostname) throw new Error(`duplicate AGENT_WECHAT_HOSTNAME in ${target}`);
      hostname = line.slice("AGENT_WECHAT_HOSTNAME=".length);
    } else if (line.startsWith("AGENT_WECHAT_MAC=")) {
      if (mac) throw new Error(`duplicate AGENT_WECHAT_MAC in ${target}`);
      mac = line.slice("AGENT_WECHAT_MAC=".length);
    } else {
      throw new Error(`unexpected line in ${target}`);
    }
  }
  const parsed = parseDeviceIdentity({ machineId, hostname, mac });
  if (!parsed) throw new Error(`incomplete identity in ${target}`);
  return parsed;
}

function parseJsonFile(target: string): DeviceIdentity {
  requireAbsentOrRegular(target);
  const data = fs.readFileSync(target);
  if (data.includes(0)) throw new Error(`NUL in ${target}`);
  const parsed = parseDeviceIdentity(JSON.parse(data.toString("utf-8")));
  if (!parsed) throw new Error(`invalid JSON identity in ${target}`);
  return parsed;
}

function exclusivePublish(envFile: string, identity: DeviceIdentity): boolean {
  requireAbsentOrRegular(envFile);
  const tmp = envFile + `.${process.pid}.${randomBytes(4).toString("hex")}`;
  const payload = [
    `AGENT_WECHAT_MACHINE_ID=${identity.machineId}`,
    `AGENT_WECHAT_HOSTNAME=${identity.hostname}`,
    `AGENT_WECHAT_MAC=${identity.mac}`,
    "",
  ].join("\n");
  fs.writeFileSync(tmp, payload, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, envFile);
  } catch {
    fs.unlinkSync(tmp);
    return false;
  }
  fs.unlinkSync(tmp);
  fs.chmodSync(envFile, 0o600);
  return true;
}

function prepareIdentDir(dir: string): void {
  const kind = pathKind(dir);
  if (kind === "symlink") throw new Error(`${dir} is a symlink`);
  if (kind === "file" || kind === "other") throw new Error(`${dir} is not a directory`);
  if (kind === "absent") fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function sameIdentity(a: DeviceIdentity, b: DeviceIdentity): boolean {
  return a.machineId === b.machineId && a.hostname === b.hostname && a.mac === b.mac;
}

/** Serialized first-run via exclusive publish of device-identity.env. */
export function ensureDeviceIdentity(dir: string): DeviceIdentity {
  prepareIdentDir(dir);
  const envFile = path.join(dir, ENV_NAME);
  const jsonFile = path.join(dir, JSON_NAME);
  requireAbsentOrRegular(envFile);
  requireAbsentOrRegular(jsonFile);

  const envId = pathKind(envFile) === "file" ? parseEnvFile(envFile) : null;
  const jsonId = pathKind(jsonFile) === "file" ? parseJsonFile(jsonFile) : null;
  if (envId && jsonId && !sameIdentity(envId, jsonId)) {
    throw new Error(`conflicting ${ENV_NAME} and ${JSON_NAME} in ${dir}`);
  }
  if (envId) {
    hardenRegular(envFile);
    return envId;
  }
  if (jsonId) {
    if (exclusivePublish(envFile, jsonId)) return parseEnvFile(envFile);
    const winner = parseEnvFile(envFile);
    if (!sameIdentity(winner, jsonId)) {
      throw new Error(`conflicting ${ENV_NAME} and ${JSON_NAME} in ${dir}`);
    }
    return winner;
  }

  const generated = generateDeviceIdentity(randomBytes(16).toString("hex"));
  if (exclusivePublish(envFile, generated)) return parseEnvFile(envFile);
  return parseEnvFile(envFile);
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
