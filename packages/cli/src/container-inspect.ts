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

export function containerInspectMatchesIdentity(raw: string, identity: DeviceIdentity): boolean {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("unexpected inspect shape");
  }
  const info = parsed[0] as {
    Config?: { Hostname?: string; Env?: string[] };
    NetworkSettings?: {
      MacAddress?: string;
      Networks?: Record<string, { MacAddress?: string } | undefined>;
    };
  };
  const env = info.Config?.Env ?? [];
  if (!Array.isArray(env)) throw new Error("unexpected inspect env shape");
  const value = (key: string) =>
    env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  const hostname = info.Config?.Hostname;
  const macs = endpointMacs(info);
  const machineId = value("AGENT_WECHAT_MACHINE_ID");
  const envHost = value("AGENT_WECHAT_HOSTNAME");
  const envMac = value("AGENT_WECHAT_MAC");
  const macOk = macs.length === 1 && macs[0] === identity.mac;
  return (
    hostname === identity.hostname &&
    machineId === identity.machineId &&
    (!envHost || envHost === identity.hostname) &&
    (!envMac || envMac === identity.mac) &&
    macOk
  );
}
