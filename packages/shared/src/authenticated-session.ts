import type { AuthenticatedSenderIdentity } from "./delivery-domain.js";

declare const authenticatedSessionCapabilityBrand: unique symbol;
export type AuthenticatedSessionCapability = {
  readonly [authenticatedSessionCapabilityBrand]: never;
};

type AuthenticatedSession = {
  readonly resolveIdentity: () => AuthenticatedSenderIdentity | undefined;
};

const CAPABILITIES = new WeakMap<object, AuthenticatedSession>();

/** Internal adapter bridge; this module is not part of the package public exports. */
export function createAuthenticatedSessionCapability(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
): AuthenticatedSessionCapability {
  const capability = Object.freeze({});
  CAPABILITIES.set(capability, { resolveIdentity });
  return capability as AuthenticatedSessionCapability;
}

export function resolveAuthenticatedSessionCapability(
  capability: AuthenticatedSessionCapability,
): (() => AuthenticatedSenderIdentity | undefined) | undefined {
  return CAPABILITIES.get(capability)?.resolveIdentity;
}
