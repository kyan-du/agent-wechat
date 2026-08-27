import type { AuthenticatedSenderIdentity } from "./delivery-domain.js";

declare const authenticatedSessionCapabilityBrand: unique symbol;
export type AuthenticatedSessionCapability = {
  readonly [authenticatedSessionCapabilityBrand]: never;
};

export type AuthenticatedSessionKeyState = {
  readonly version: 1;
  readonly keyId: string;
  readonly integrityKey: string;
};

export type AuthenticatedSessionRecord = {
  readonly resolveIdentity: () => AuthenticatedSenderIdentity | undefined;
  readonly integrityKey: Uint8Array;
  readonly keyId: string;
  readonly revoked: boolean;
};

export type AuthenticatedSessionAdapter = {
  readonly capability: AuthenticatedSessionCapability;
  readonly keyState: AuthenticatedSessionKeyState;
  readonly revoke: () => void;
};

const CAPABILITIES = new WeakMap<object, AuthenticatedSessionRecord>();
const HEX = /^[a-f0-9]+$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string, expectedLength: number): Uint8Array {
  if (value.length !== expectedLength * 2 || !HEX.test(value)) throw new Error("INVALID_AUTHENTICATED_SESSION_KEY_STATE");
  const result = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function createAdapter(resolveIdentity: () => AuthenticatedSenderIdentity | undefined, keyState: AuthenticatedSessionKeyState): AuthenticatedSessionAdapter {
  const capability = Object.freeze({});
  let revoked = false;
  const record = {
    resolveIdentity,
    integrityKey: bytes(keyState.integrityKey, 32),
    keyId: keyState.keyId,
    get revoked() { return revoked; },
  } as AuthenticatedSessionRecord;
  CAPABILITIES.set(capability, record);
  return Object.freeze({
    capability: capability as AuthenticatedSessionCapability,
    keyState: Object.freeze({ ...keyState }),
    revoke: () => { revoked = true; },
  });
}

/** Adapter-owned construction point; generated key state must be stored by the authenticated adapter. */
export function createAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
): AuthenticatedSessionAdapter {
  const key = new Uint8Array(32);
  const keyId = new Uint8Array(16);
  globalThis.crypto.getRandomValues(key);
  globalThis.crypto.getRandomValues(keyId);
  return createAdapter(resolveIdentity, { version: 1, keyId: hex(keyId), integrityKey: hex(key) });
}

/** Restore using key state recovered from protected authenticated-session storage. */
export function restoreAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
  keyState: AuthenticatedSessionKeyState,
): AuthenticatedSessionAdapter {
  if (keyState.version !== 1 || keyState.keyId.length !== 32 || !HEX.test(keyState.keyId)) throw new Error("INVALID_AUTHENTICATED_SESSION_KEY_STATE");
  return createAdapter(resolveIdentity, keyState);
}

export function resolveAuthenticatedSessionCapability(
  capability: AuthenticatedSessionCapability,
): AuthenticatedSessionRecord | undefined {
  const record = CAPABILITIES.get(capability);
  return record && !record.revoked ? record : undefined;
}
