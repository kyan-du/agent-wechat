import type { AuthenticatedSenderIdentity } from "./delivery-domain.js";

declare const authenticatedSessionCapabilityBrand: unique symbol;
export type AuthenticatedSessionCapability = {
  readonly [authenticatedSessionCapabilityBrand]: never;
};

export type AuthenticatedSessionRecord = {
  readonly resolveIdentity: () => AuthenticatedSenderIdentity | undefined;
  readonly integrityKey: Uint8Array;
};

export type AuthenticatedSessionAdapter = {
  readonly capability: AuthenticatedSessionCapability;
};

const CAPABILITIES = new WeakMap<object, AuthenticatedSessionRecord>();

/** Adapter-owned construction point; the public package does not export this module. */
export function createAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
): AuthenticatedSessionAdapter {
  const capability = Object.freeze({});
  const integrityKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(integrityKey);
  CAPABILITIES.set(capability, { resolveIdentity, integrityKey });
  return Object.freeze({ capability: capability as AuthenticatedSessionCapability });
}

export function resolveAuthenticatedSessionCapability(
  capability: AuthenticatedSessionCapability,
): AuthenticatedSessionRecord | undefined {
  return CAPABILITIES.get(capability);
}
