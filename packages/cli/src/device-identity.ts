/** Same machine-id / hostname / MAC rules as scripts/device-identity.sh. */

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
