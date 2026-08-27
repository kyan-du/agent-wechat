import type { AuthenticatedSenderIdentity } from "./delivery-domain.js";

declare const authenticatedSessionCapabilityBrand: unique symbol;
declare const authenticatedSessionStoreBrand: unique symbol;
export type AuthenticatedSessionCapability = {
  readonly [authenticatedSessionCapabilityBrand]: never;
};

/** Opaque handle implemented by the authenticated adapter's protected durable store. */
export type AuthenticatedSessionStore = {
  readonly [authenticatedSessionStoreBrand]: never;
};

export type AuthenticatedSessionRecord = {
  readonly resolveIdentity: () => AuthenticatedSenderIdentity | undefined;
  readonly integrityKey: Uint8Array;
  readonly keyId: string;
  readonly revoked: boolean;
};

export type AuthenticatedSessionAdapter = {
  readonly capability: AuthenticatedSessionCapability;
  readonly store: AuthenticatedSessionStore;
  readonly revoke: () => void;
  /** Atomically revokes this generation and returns the next generation. */
  readonly rotate: () => AuthenticatedSessionAdapter;
};

type PersistedKey = Readonly<{
  keyId: string;
  integrityKey: Uint8Array;
  accountId: string;
  sessionId: string;
  generation: number;
}>;
type StoreRecord = {
  current?: PersistedKey;
  activeToken?: object;
  readonly revokedKeyIds: Set<string>;
  generation: number;
};

const CAPABILITIES = new WeakMap<object, AuthenticatedSessionRecord>();
const STORES = new WeakMap<object, StoreRecord>();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storeRecord(store: AuthenticatedSessionStore): StoreRecord {
  const record = STORES.get(store);
  if (!record) throw new Error("UNAUTHENTICATED_SESSION_STORE");
  return record;
}

function validIdentity(identity: AuthenticatedSenderIdentity | undefined): AuthenticatedSenderIdentity {
  if (!identity || !identity.accountId.trim() || !identity.sessionId.trim() || !identity.senderId.trim()) throw new Error("UNVERIFIED_SENDER_PROVENANCE");
  return Object.freeze({ ...identity });
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function newKey(identity: AuthenticatedSenderIdentity, generation: number): PersistedKey {
  return Object.freeze({ keyId: hex(randomBytes(16)), integrityKey: randomBytes(32), accountId: identity.accountId, sessionId: identity.sessionId, generation });
}

/** Internal adapter bridge used by the real authenticated-session implementation and tests. */
export function createAuthenticatedSessionStore(): AuthenticatedSessionStore {
  const store = Object.freeze({});
  STORES.set(store, { revokedKeyIds: new Set(), generation: 0 });
  return store as AuthenticatedSessionStore;
}

function createAdapter(resolveIdentity: () => AuthenticatedSenderIdentity | undefined, store: AuthenticatedSessionStore, key: PersistedKey): AuthenticatedSessionAdapter {
  const capability = Object.freeze({});
  const token = Object.freeze({});
  const state = storeRecord(store);
  state.activeToken = token;
  const record = {
    resolveIdentity,
    integrityKey: key.integrityKey,
    keyId: key.keyId,
    get revoked() {
      const current = storeRecord(store);
      return current.current?.keyId !== key.keyId || current.activeToken !== token || current.revokedKeyIds.has(key.keyId);
    },
  } as AuthenticatedSessionRecord;
  CAPABILITIES.set(capability, record);

  const revoke = (): void => {
    const state = storeRecord(store);
    state.revokedKeyIds.add(key.keyId);
    if (state.current?.keyId === key.keyId && state.activeToken === token) {
      state.current = undefined;
      state.activeToken = undefined;
    }
  };
  const rotate = (): AuthenticatedSessionAdapter => {
    const identity = validIdentity(resolveIdentity());
    const state = storeRecord(store);
    if (state.current?.keyId !== key.keyId || state.activeToken !== token || state.revokedKeyIds.has(key.keyId)) throw new Error("REVOKED_AUTHENTICATED_SESSION");
    state.revokedKeyIds.add(key.keyId);
    const next = newKey(identity, ++state.generation);
    state.current = next;
    return createAdapter(resolveIdentity, store, next);
  };
  return Object.freeze({ capability: capability as AuthenticatedSessionCapability, store, revoke, rotate });
}

/** Adapter-owned construction point; key material remains inside its protected durable store. */
export function createAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
  store = createAuthenticatedSessionStore(),
): AuthenticatedSessionAdapter {
  const identity = validIdentity(resolveIdentity());
  const state = storeRecord(store);
  if (state.current) throw new Error("AUTHENTICATED_SESSION_ALREADY_EXISTS");
  const key = newKey(identity, ++state.generation);
  state.current = key;
  return createAdapter(resolveIdentity, store, key);
}

/** Restore only through the authenticated adapter's opaque protected durable store. */
export function restoreAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
  store: AuthenticatedSessionStore,
): AuthenticatedSessionAdapter {
  const identity = validIdentity(resolveIdentity());
  const state = storeRecord(store);
  const key = state.current;
  if (!key || state.revokedKeyIds.has(key.keyId)) throw new Error("REVOKED_AUTHENTICATED_SESSION");
  if (key.accountId !== identity.accountId || key.sessionId !== identity.sessionId) throw new Error("AUTHENTICATED_SESSION_IDENTITY_MISMATCH");
  return createAdapter(resolveIdentity, store, key);
}

export function resolveAuthenticatedSessionCapability(
  capability: AuthenticatedSessionCapability,
): AuthenticatedSessionRecord | undefined {
  const record = CAPABILITIES.get(capability);
  return record && !record.revoked ? record : undefined;
}
