import type { AuthenticatedSenderIdentity } from "./delivery-domain.js";

declare const authenticatedSessionCapabilityBrand: unique symbol;
declare const authenticatedSessionStoreBrand: unique symbol;
export type AuthenticatedSessionCapability = {
  readonly [authenticatedSessionCapabilityBrand]: never;
};

/**
 * Backend-owned handle for protected durable session state. The backend must
 * protect key material and make writes atomic before returning successfully.
 */
export type AuthenticatedSessionStoreBackend = {
  readonly read: () => AuthenticatedSessionStoreSnapshot | undefined;
  /** Must durably commit the complete replacement snapshot or throw. */
  readonly write: (snapshot: AuthenticatedSessionStoreSnapshot) => void;
};

export type AuthenticatedSessionStoreSnapshot = Readonly<{
  version: 1;
  generation: number;
  closed: boolean;
  current?: Readonly<{
    keyId: string;
    integrityKey: string;
    accountId: string;
    sessionId: string;
    senderId: string;
    generation: number;
  }>;
  revokedKeyIds: readonly string[];
}>;

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
  senderId: string;
  generation: number;
}>;
type StoreRecord = {
  readonly backend: AuthenticatedSessionStoreBackend;
  current?: PersistedKey;
  activeToken?: object;
  readonly revokedKeyIds: Set<string>;
  generation: number;
  closed: boolean;
};

const CAPABILITIES = new WeakMap<object, AuthenticatedSessionRecord>();
const STORES = new WeakMap<object, StoreRecord>();
const HEX = /^[a-f0-9]+$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string, expectedLength: number): Uint8Array {
  if (typeof value !== "string" || value.length !== expectedLength * 2 || !HEX.test(value)) throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  const result = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
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
  return Object.freeze({ keyId: hex(randomBytes(16)), integrityKey: randomBytes(32), accountId: identity.accountId, sessionId: identity.sessionId, senderId: identity.senderId, generation });
}

function validSnapshot(snapshot: AuthenticatedSessionStoreSnapshot | undefined): AuthenticatedSessionStoreSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0 || typeof snapshot.closed !== "boolean" || !Array.isArray(snapshot.revokedKeyIds)) throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  const revokedKeyIds = snapshot.revokedKeyIds.map((keyId) => {
    bytes(keyId, 16);
    return keyId;
  });
  if (new Set(revokedKeyIds).size !== revokedKeyIds.length) throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  if (!snapshot.current) return Object.freeze({ version: 1, generation: snapshot.generation, closed: snapshot.closed, revokedKeyIds: Object.freeze(revokedKeyIds) });
  const current = snapshot.current;
  if (!Number.isSafeInteger(current.generation) || current.generation <= 0 || current.generation > snapshot.generation || !current.accountId.trim() || !current.sessionId.trim() || !current.senderId.trim()) throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  bytes(current.keyId, 16);
  bytes(current.integrityKey, 32);
  if (revokedKeyIds.includes(current.keyId)) throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  return Object.freeze({ version: 1, generation: snapshot.generation, closed: snapshot.closed, current: Object.freeze({ ...current }), revokedKeyIds: Object.freeze(revokedKeyIds) });
}

function snapshotFromState(state: StoreRecord): AuthenticatedSessionStoreSnapshot {
  return Object.freeze({
    version: 1,
    generation: state.generation,
    closed: state.closed,
    ...(state.current ? { current: Object.freeze({ keyId: state.current.keyId, integrityKey: hex(state.current.integrityKey), accountId: state.current.accountId, sessionId: state.current.sessionId, senderId: state.current.senderId, generation: state.current.generation }) } : {}),
    revokedKeyIds: Object.freeze([...state.revokedKeyIds]),
  });
}

function stateFromSnapshot(backend: AuthenticatedSessionStoreBackend, snapshot: AuthenticatedSessionStoreSnapshot | undefined): StoreRecord {
  const validated = validSnapshot(snapshot);
  const current = validated?.current;
  return {
    backend,
    ...(current ? { current: Object.freeze({ ...current, integrityKey: bytes(current.integrityKey, 32) }) } : {}),
    revokedKeyIds: new Set(validated?.revokedKeyIds ?? []),
    generation: validated?.generation ?? 0,
    closed: validated?.closed ?? false,
  };
}

function commitState(state: StoreRecord, next: { current?: PersistedKey; generation: number; closed: boolean; revokedKeyIds: Set<string> }): void {
  const current = state.current;
  const generation = state.generation;
  const closed = state.closed;
  const revokedKeyIds = new Set(state.revokedKeyIds);
  state.current = next.current;
  state.generation = next.generation;
  state.closed = next.closed;
  state.revokedKeyIds.clear();
  for (const keyId of next.revokedKeyIds) state.revokedKeyIds.add(keyId);
  try {
    state.backend.write(snapshotFromState(state));
  } catch (error) {
    state.current = current;
    state.generation = generation;
    state.closed = closed;
    state.revokedKeyIds.clear();
    for (const keyId of revokedKeyIds) state.revokedKeyIds.add(keyId);
    throw error;
  }
}

/** Create a store backed by adapter-owned protected durable storage. */
export function createAuthenticatedSessionStore(backend: AuthenticatedSessionStoreBackend): AuthenticatedSessionStore {
  if (!backend || typeof backend.read !== "function" || typeof backend.write !== "function") throw new Error("INVALID_AUTHENTICATED_SESSION_STORE");
  const store = Object.freeze({});
  const persisted = backend.read();
  const state = stateFromSnapshot(backend, persisted);
  STORES.set(store, state);
  if (persisted === undefined) backend.write(snapshotFromState(state));
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
      return current.closed || current.current?.keyId !== key.keyId || current.activeToken !== token || current.revokedKeyIds.has(key.keyId);
    },
  } as AuthenticatedSessionRecord;
  CAPABILITIES.set(capability, record);

  const revoke = (): void => {
    const state = storeRecord(store);
    // A stale adapter must not be able to revoke a newer generation.
    if (state.closed || state.current?.keyId !== key.keyId || state.activeToken !== token) return;
    const revokedKeyIds = new Set(state.revokedKeyIds);
    revokedKeyIds.add(key.keyId);
    commitState(state, { current: undefined, generation: state.generation, closed: true, revokedKeyIds });
    state.activeToken = undefined;
  };
  const rotate = (): AuthenticatedSessionAdapter => {
    const identity = validIdentity(resolveIdentity());
    const state = storeRecord(store);
    if (state.closed || state.current?.keyId !== key.keyId || state.activeToken !== token || state.revokedKeyIds.has(key.keyId)) throw new Error("REVOKED_AUTHENTICATED_SESSION");
    const next = newKey(identity, state.generation + 1);
    const revokedKeyIds = new Set(state.revokedKeyIds);
    revokedKeyIds.add(key.keyId);
    commitState(state, { current: next, generation: next.generation, closed: false, revokedKeyIds });
    return createAdapter(resolveIdentity, store, next);
  };
  return Object.freeze({ capability: capability as AuthenticatedSessionCapability, store, revoke, rotate });
}

/** Adapter-owned construction point; key material remains inside its protected durable store. */
export function createAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
  store: AuthenticatedSessionStore,
): AuthenticatedSessionAdapter {
  const identity = validIdentity(resolveIdentity());
  const state = storeRecord(store);
  if (state.closed) throw new Error("REVOKED_AUTHENTICATED_SESSION");
  if (state.current) throw new Error("AUTHENTICATED_SESSION_ALREADY_EXISTS");
  const key = newKey(identity, state.generation + 1);
  commitState(state, { current: key, generation: key.generation, closed: false, revokedKeyIds: new Set(state.revokedKeyIds) });
  return createAdapter(resolveIdentity, store, key);
}

/** Restore after a process restart through the adapter-owned protected durable store. */
export function restoreAuthenticatedSessionAdapter(
  resolveIdentity: () => AuthenticatedSenderIdentity | undefined,
  store: AuthenticatedSessionStore,
): AuthenticatedSessionAdapter {
  const identity = validIdentity(resolveIdentity());
  const state = storeRecord(store);
  const key = state.current;
  if (state.closed || !key || state.revokedKeyIds.has(key.keyId)) throw new Error("REVOKED_AUTHENTICATED_SESSION");
  if (key.accountId !== identity.accountId || key.sessionId !== identity.sessionId || key.senderId !== identity.senderId) throw new Error("AUTHENTICATED_SESSION_IDENTITY_MISMATCH");
  return createAdapter(resolveIdentity, store, key);
}

export function resolveAuthenticatedSessionCapability(
  capability: AuthenticatedSessionCapability,
): AuthenticatedSessionRecord | undefined {
  const record = CAPABILITIES.get(capability);
  return record && !record.revoked ? record : undefined;
}
