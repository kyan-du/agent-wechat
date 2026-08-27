import { resolveAuthenticatedSessionCapability } from "./authenticated-session.js";
import type { AuthenticatedSessionCapability } from "./authenticated-session.js";
import type { AuthenticatedSenderBoundary, TrustedSenderProvenance } from "../delivery-domain.js";

declare const authenticatedSenderBoundaryBrand: unique symbol;
export type InternalAuthenticatedSenderBoundary = { readonly [authenticatedSenderBoundaryBrand]: never };

const AUTHENTICATED_BOUNDARIES = new WeakMap<object, ReturnType<typeof resolveAuthenticatedSessionCapability>>();
const TRUSTED_PROVENANCES = new WeakSet<object>();
const PROVENANCE_RECORDS = new WeakMap<object, { session: NonNullable<ReturnType<typeof resolveAuthenticatedSessionCapability>> }>();

export function createAuthenticatedSenderBoundary(capability: AuthenticatedSessionCapability): AuthenticatedSenderBoundary {
  const session = resolveAuthenticatedSessionCapability(capability);
  if (!session) throw new Error("UNAUTHENTICATED_SESSION_CAPABILITY");
  const boundary = Object.freeze({});
  AUTHENTICATED_BOUNDARIES.set(boundary, session);
  return boundary as AuthenticatedSenderBoundary;
}

export function issueTrustedSenderProvenance(boundary: AuthenticatedSenderBoundary, verifiedAt = new Date()): TrustedSenderProvenance {
  const session = AUTHENTICATED_BOUNDARIES.get(boundary);
  const identity = session?.resolveIdentity();
  if (!session || session.revoked || !identity || !identity.accountId.trim() || !identity.sessionId.trim() || !identity.senderId.trim()) throw new Error("UNVERIFIED_SENDER_PROVENANCE");
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error("INVALID_SENDER_PROVENANCE_TIME");
  const provenance = Object.freeze({ ...identity, verifiedAt: verifiedAt.toISOString(), __trustedSenderProvenance: true as const });
  TRUSTED_PROVENANCES.add(provenance);
  PROVENANCE_RECORDS.set(provenance, { session });
  return provenance;
}

export function activeSessionFor(provenance: TrustedSenderProvenance) {
  const record = PROVENANCE_RECORDS.get(provenance);
  if (!TRUSTED_PROVENANCES.has(provenance) || !record?.session || record.session.revoked) throw new Error("UNTRUSTED_SENDER_PROVENANCE");
  const identity = record.session.resolveIdentity();
  if (!identity || identity.accountId !== provenance.accountId || identity.sessionId !== provenance.sessionId || identity.senderId !== provenance.senderId) throw new Error("REVOKED_SENDER_PROVENANCE");
  return record.session;
}
