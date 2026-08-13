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
  Config?: { MacAddress?: string };
  NetworkSettings?: {
    Networks?: Record<string, { MacAddress?: string } | undefined>;
  };
}): string[] {
  const macs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) macs.add(value.toLowerCase());
  };
  add(info.HostConfig?.MacAddress);
  add(info.Config?.MacAddress);
  for (const network of Object.values(info.NetworkSettings?.Networks ?? {})) {
    add(network?.MacAddress);
  }
  return [...macs];
}

export function uniqueInspectEnv(env: unknown, key: string): string {
  if (!Array.isArray(env)) throw new Error("unexpected inspect env shape");
  const values = env
    .filter((entry): entry is string => typeof entry === "string" && entry.startsWith(`${key}=`))
    .map((entry) => entry.slice(key.length + 1));
  if (values.length === 0) throw new Error(`missing ${key}`);
  if (values.length > 1) throw new Error(`duplicate ${key}`);
  return values[0];
}

export function containerInspectMatchesIdentity(raw: string, identity: DeviceIdentity): boolean {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("unexpected inspect shape");
  }
  const info = parsed[0] as {
    HostConfig?: { MacAddress?: string };
    Config?: { Hostname?: string; Env?: string[]; MacAddress?: string };
    NetworkSettings?: {
      MacAddress?: string;
      Networks?: Record<string, { MacAddress?: string } | undefined>;
    };
  };
  const env = info.Config?.Env ?? [];
  const machineId = uniqueInspectEnv(env, "AGENT_WECHAT_MACHINE_ID");
  const envHost = uniqueInspectEnv(env, "AGENT_WECHAT_HOSTNAME");
  const envMac = uniqueInspectEnv(env, "AGENT_WECHAT_MAC");
  const hostname = info.Config?.Hostname;
  const liveMacs = endpointMacs(info);
  const durableMacs = configuredMacs(info);
  if (liveMacs.some((mac) => mac !== identity.mac)) return false;
  if (durableMacs.some((mac) => mac !== identity.mac)) return false;
  return (
    hostname === identity.hostname &&
    machineId === identity.machineId &&
    envHost === identity.hostname &&
    envMac === identity.mac
  );
}

export type ExistingContainerDecision =
  | { action: "use-existing"; start: boolean }
  | { action: "fail"; reason: "inspect-failed" | "identity-mismatch" };

/** Once docker ps returned an ID, inspect errors are never "absent". */
export function decideExistingContainer(input: {
  running: boolean;
  inspectOk: boolean;
  inspectRaw?: string;
  identity: DeviceIdentity;
}): ExistingContainerDecision {
  if (!input.inspectOk || input.inspectRaw === undefined) {
    return { action: "fail", reason: "inspect-failed" };
  }
  try {
    if (!containerInspectMatchesIdentity(input.inspectRaw, input.identity)) {
      return { action: "fail", reason: "identity-mismatch" };
    }
  } catch {
    return { action: "fail", reason: "identity-mismatch" };
  }
  return { action: "use-existing", start: !input.running };
}
