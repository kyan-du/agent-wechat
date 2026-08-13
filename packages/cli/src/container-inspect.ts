import type { DeviceIdentity } from "./device-identity.ts";

export function endpointMacs(info: {
  NetworkSettings?: {
    MacAddress?: string;
    Networks?: Record<string, { MacAddress?: string } | undefined>;
  };
}): string[] {
  const macs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) macs.add(value.toLowerCase());
  };
  add(info.NetworkSettings?.MacAddress);
  for (const network of Object.values(info.NetworkSettings?.Networks ?? {})) {
    add(network?.MacAddress);
  }
  return [...macs];
}

export function configuredMacs(info: {
  HostConfig?: { MacAddress?: string };
  NetworkSettings?: {
    Networks?: Record<string, { MacAddress?: string } | undefined>;
  };
}): string[] {
  const macs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) macs.add(value.toLowerCase());
  };
  add(info.HostConfig?.MacAddress);
  for (const network of Object.values(info.NetworkSettings?.Networks ?? {})) {
    add(network?.MacAddress);
  }
  return [...macs];
}

function requiredEnv(env: string[], key: string): string | null {
  let found: string | null = null;
  for (const entry of env) {
    if (!entry.startsWith(`${key}=`)) continue;
    if (found !== null) throw new Error(`duplicate ${key} in container inspect env`);
    found = entry.slice(key.length + 1);
  }
  return found;
}

export function containerInspectMatchesIdentity(raw: string, identity: DeviceIdentity): boolean {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("unexpected inspect shape");
  }
  const info = parsed[0] as {
    HostConfig?: { MacAddress?: string };
    Config?: { Hostname?: string; Env?: string[] };
    NetworkSettings?: {
      MacAddress?: string;
      Networks?: Record<string, { MacAddress?: string } | undefined>;
    };
  };
  const env = info.Config?.Env ?? [];
  if (!Array.isArray(env)) throw new Error("unexpected inspect env shape");
  const hostname = info.Config?.Hostname;
  const machineId = requiredEnv(env, "AGENT_WECHAT_MACHINE_ID");
  const envHost = requiredEnv(env, "AGENT_WECHAT_HOSTNAME");
  const envMac = requiredEnv(env, "AGENT_WECHAT_MAC");
  const durableMacs = configuredMacs(info);
  const liveMacs = endpointMacs(info);
  const durableMacOk = durableMacs.length === 1 && durableMacs[0] === identity.mac;
  const liveMacOk = liveMacs.length === 0 || (liveMacs.length === 1 && liveMacs[0] === identity.mac);
  return (
    hostname === identity.hostname &&
    machineId === identity.machineId &&
    envHost === identity.hostname &&
    envMac === identity.mac &&
    durableMacOk &&
    liveMacOk
  );
}
