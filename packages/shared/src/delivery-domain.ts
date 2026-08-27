import { resolveAuthenticatedSessionCapability } from "./internal/authenticated-session.js";
import type { AuthenticatedSessionCapability } from "./internal/authenticated-session.js";
import { deliveryAttemptSchema } from "./schemas/index.js";
import type { Message, SendResult } from "./types/index.js";

export const DELIVERY_DOMAIN_SCHEMA_VERSION = 1 as const;
export type DeliveryState = "queued" | "composing" | "submitted" | "observed_in_chat" | "confirmed" | "uncertain" | "failed";
export type DeliveryCause = "send_accepted" | "target_sender_and_payload_match" | "observation_confirmed" | "target_mismatch" | "sender_unverified" | "payload_mismatch" | "pre_commit_failure" | "post_commit_uncertain";
export type AuthenticatedSenderIdentity = { readonly accountId: string; readonly sessionId: string; readonly senderId: string };
export type TrustedSenderProvenance = AuthenticatedSenderIdentity & { readonly verifiedAt: string; readonly __trustedSenderProvenance: true };
export type { AuthenticatedSessionCapability } from "./internal/authenticated-session.js";
declare const authenticatedSenderBoundaryBrand: unique symbol;
export type AuthenticatedSenderBoundary = { readonly [authenticatedSenderBoundaryBrand]: never };

export type DeliveryAttempt = {
  schemaVersion: typeof DELIVERY_DOMAIN_SCHEMA_VERSION;
  senderId: string;
  senderAccountId: string;
  senderSessionId: string;
  targetChatId: string;
  payloadDigest: string;
  state: DeliveryState;
  commitAttempted: boolean;
  createdAt: string;
  updatedAt: string;
  observedLocalId?: number;
  transitions: DeliveryTransition[];
  idempotencyKey?: string;
  integrityTag: string;
  sessionKeyId: string;
};
export type DeliveryObservation = Pick<Message, "chatId" | "localId" | "serverId" | "timestamp" | "type" | "sender" | "content">;
export type DeliveryTransition = { from: DeliveryState; to: DeliveryState; at: string; reason: DeliveryCause };

const TRUSTED_PROVENANCES = new WeakSet<object>();
const AUTHENTICATED_BOUNDARIES = new WeakMap<object, ReturnType<typeof resolveAuthenticatedSessionCapability>>();
const PROVENANCE_RECORDS = new WeakMap<object, { session: NonNullable<ReturnType<typeof resolveAuthenticatedSessionCapability>> }>();
const TERMINAL_STATES = new Set<DeliveryState>(["confirmed", "uncertain", "failed"]);
const EDGE_CAUSES = new Map<string, ReadonlySet<DeliveryCause>>([
  ["queued:composing", new Set(["send_accepted"])], ["queued:submitted", new Set(["send_accepted"])], ["composing:submitted", new Set(["send_accepted"])],
  ["submitted:observed_in_chat", new Set(["target_sender_and_payload_match"])], ["observed_in_chat:confirmed", new Set(["observation_confirmed"])],
  ["queued:uncertain", new Set(["post_commit_uncertain"])], ["composing:uncertain", new Set(["post_commit_uncertain"])],
  ["submitted:uncertain", new Set(["target_mismatch", "sender_unverified", "payload_mismatch", "post_commit_uncertain"])],
  ["observed_in_chat:uncertain", new Set(["target_mismatch", "sender_unverified", "payload_mismatch", "post_commit_uncertain"])],
  ["queued:failed", new Set(["pre_commit_failure"])], ["composing:failed", new Set(["pre_commit_failure"])],
]);

export async function payloadDigest(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function integrityTag(unsigned: Omit<DeliveryAttempt, "integrityTag">, key: Uint8Array): Promise<string> {
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonicalUnsignedAttempt(unsigned)));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

const MAX_ATTEMPT_INPUT_BYTES = 64 * 1024;
const ATTEMPT_KEYS = new Set(["schemaVersion", "senderId", "senderAccountId", "senderSessionId", "targetChatId", "payloadDigest", "state", "commitAttempted", "createdAt", "updatedAt", "observedLocalId", "transitions", "idempotencyKey", "integrityTag", "sessionKeyId"]);
const TRANSITION_KEYS = new Set(["from", "to", "at", "reason"]);

function assertBoundedAttemptInput(value: unknown): asserts value is DeliveryAttempt {
  const seen = new Set<object>();
  let size = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 4) throw new Error("INVALID_DELIVERY_ATTEMPT_INPUT");
    if (typeof current === "string") { size += new TextEncoder().encode(current).byteLength; if (size > MAX_ATTEMPT_INPUT_BYTES) throw new Error("DELIVERY_ATTEMPT_TOO_LARGE"); return; }
    if (typeof current === "number" || typeof current === "boolean" || current === undefined) { size += 8; return; }
    if (!current || typeof current !== "object") throw new Error("INVALID_DELIVERY_ATTEMPT_INPUT");
    if (seen.has(current)) throw new Error("CYCLIC_DELIVERY_ATTEMPT");
    seen.add(current);
    if (Array.isArray(current)) { if (current.length > 32) throw new Error("DELIVERY_ATTEMPT_TOO_LARGE"); for (const item of current) visit(item, depth + 1); }
    else { const keys = Object.keys(current); const allowed = depth === 0 ? ATTEMPT_KEYS : depth === 2 ? TRANSITION_KEYS : new Set<string>(); if (keys.length > allowed.size || keys.some((key) => !allowed.has(key))) throw new Error("INVALID_DELIVERY_ATTEMPT_INPUT"); for (const key of keys) { size += key.length; visit((current as Record<string, unknown>)[key], depth + 1); } }
    seen.delete(current);
  };
  visit(value, 0);
  if (size > MAX_ATTEMPT_INPUT_BYTES) throw new Error("DELIVERY_ATTEMPT_TOO_LARGE");
}

function canonicalUnsignedAttempt(attempt: Omit<DeliveryAttempt, "integrityTag">): string {
  const normalized: Record<string, unknown> = {
    schemaVersion: attempt.schemaVersion, senderId: attempt.senderId, senderAccountId: attempt.senderAccountId, senderSessionId: attempt.senderSessionId,
    targetChatId: attempt.targetChatId, payloadDigest: attempt.payloadDigest, state: attempt.state, commitAttempted: attempt.commitAttempted,
    createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
    transitions: attempt.transitions.map(({ from, to, at, reason }) => ({ from, to, at, reason })), sessionKeyId: attempt.sessionKeyId,
  };
  if (attempt.observedLocalId !== undefined) normalized.observedLocalId = attempt.observedLocalId;
  if (attempt.idempotencyKey !== undefined) normalized.idempotencyKey = attempt.idempotencyKey;
  return JSON.stringify(normalized);
}

function validateAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  assertBoundedAttemptInput(attempt);
  const validated = deliveryAttemptSchema.strict().parse(attempt);
  const createdAt = Date.parse(validated.createdAt);
  const updatedAt = Date.parse(validated.updatedAt);
  const lastTransition = validated.transitions.at(-1);
  if (validated.transitions.length === 0 && validated.state !== "queued") throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (lastTransition && lastTransition.to !== validated.state) throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (validated.observedLocalId !== undefined && !["observed_in_chat", "confirmed"].includes(validated.state)) throw new Error("INVALID_DELIVERY_OBSERVATION_STATE");
  if (updatedAt < createdAt) throw new Error("INVALID_DELIVERY_TIME");
  if (lastTransition && Date.parse(lastTransition.at) > updatedAt) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
  for (let index = 0; index < validated.transitions.length; index += 1) {
    const transition = validated.transitions[index]!;
    const previous = validated.transitions[index - 1];
    if (previous && transition.from !== previous.to) throw new Error("INVALID_DELIVERY_TRANSITION_CHAIN");
    if (previous && Date.parse(transition.at) < Date.parse(previous.at)) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (index === 0 && Date.parse(transition.at) < createdAt) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (!canAdvanceDelivery(transition.from, transition.to, transition.reason)) throw new Error("INVALID_DELIVERY_TRANSITION_EDGE");
    if (transition.to === "uncertain" && transition.reason === "post_commit_uncertain" && !validated.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
    if (transition.to === "failed" && transition.reason === "pre_commit_failure" && validated.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  }
  return validated as DeliveryAttempt;
}

function activeSessionFor(provenance: TrustedSenderProvenance): NonNullable<ReturnType<typeof resolveAuthenticatedSessionCapability>> {
  const record = PROVENANCE_RECORDS.get(provenance);
  if (!TRUSTED_PROVENANCES.has(provenance) || !record?.session || record.session.revoked) throw new Error("UNTRUSTED_SENDER_PROVENANCE");
  const identity = record.session.resolveIdentity();
  if (!identity || identity.accountId !== provenance.accountId || identity.sessionId !== provenance.sessionId || identity.senderId !== provenance.senderId) throw new Error("REVOKED_SENDER_PROVENANCE");
  return record.session;
}

async function authenticateAttempt(attempt: DeliveryAttempt, provenance: TrustedSenderProvenance): Promise<DeliveryAttempt> {
  const session = activeSessionFor(provenance);
  const normalized = validateAttempt(attempt);
  if (normalized.senderId !== provenance.senderId || normalized.senderAccountId !== provenance.accountId || normalized.senderSessionId !== provenance.sessionId) throw new Error("REVOKED_SENDER_PROVENANCE");
  if (normalized.sessionKeyId !== session.keyId) throw new Error("UNKNOWN_AUTHENTICATED_SESSION_KEY");
  const { integrityTag: supplied, ...unsigned } = normalized;
  const expected = await integrityTag(unsigned, session.integrityKey);
  if (supplied !== expected) throw new Error("TAMPERED_DELIVERY_ATTEMPT");
  return normalized;
}

async function buildAttempt(unsigned: Omit<DeliveryAttempt, "integrityTag">, provenance: TrustedSenderProvenance): Promise<DeliveryAttempt> {
  const session = activeSessionFor(provenance);
  return { ...unsigned, integrityTag: await integrityTag(unsigned, session.integrityKey) };
}

export async function createQueuedDelivery(targetChatId: string, payload: string, provenance: TrustedSenderProvenance, now = new Date(), idempotencyKey?: string): Promise<DeliveryAttempt> {
  if (!TRUSTED_PROVENANCES.has(provenance)) throw new Error("UNTRUSTED_SENDER_PROVENANCE");
  if (Date.parse(provenance.verifiedAt) > now.getTime()) throw new Error("INVALID_SENDER_PROVENANCE_TIME");
  const timestamp = now.toISOString();
  const session = activeSessionFor(provenance);
  return validateAttempt(await buildAttempt({ schemaVersion: 1, senderId: provenance.senderId, senderAccountId: provenance.accountId, senderSessionId: provenance.sessionId, targetChatId, payloadDigest: await payloadDigest(payload), state: "queued", commitAttempted: false, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [], sessionKeyId: session.keyId }, provenance));
}

export async function advanceDelivery(attempt: DeliveryAttempt, to: DeliveryState, reason: DeliveryCause, provenance: TrustedSenderProvenance, now = new Date()): Promise<DeliveryAttempt> {
  const current = await authenticateAttempt(attempt, provenance);
  if (to === "uncertain" && reason === "post_commit_uncertain" && !current.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  if (to === "failed" && reason === "pre_commit_failure" && current.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  if (!canAdvanceDelivery(current.state, to, reason)) return Object.freeze({ ...current, transitions: current.transitions.map((transition) => Object.freeze({ ...transition })) });
  const timestamp = now.toISOString();
  const { integrityTag: _integrityTag, ...unsigned } = current;
  return validateAttempt(await buildAttempt({ ...unsigned, state: to, updatedAt: timestamp, transitions: [...current.transitions, { from: current.state, to, at: timestamp, reason }] }, provenance));
}

export async function deliveryAfterSend(result: Pick<SendResult, "success" | "commitAttempted">, targetChatId: string, payload: string, now: Date, idempotencyKey: string | undefined, provenance: TrustedSenderProvenance): Promise<DeliveryAttempt> {
  if (!TRUSTED_PROVENANCES.has(provenance)) throw new Error("UNTRUSTED_SENDER_PROVENANCE");
  if (Date.parse(provenance.verifiedAt) > now.getTime()) throw new Error("INVALID_SENDER_PROVENANCE_TIME");
  const timestamp = now.toISOString();
  const state: DeliveryState = result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed";
  const session = activeSessionFor(provenance);
  return validateAttempt(await buildAttempt({ schemaVersion: 1, senderId: provenance.senderId, senderAccountId: provenance.accountId, senderSessionId: provenance.sessionId, targetChatId, payloadDigest: await payloadDigest(payload), state, commitAttempted: result.commitAttempted === true, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [{ from: "queued", to: state, at: timestamp, reason: result.success ? "send_accepted" : result.commitAttempted ? "post_commit_uncertain" : "pre_commit_failure" }], sessionKeyId: session.keyId }, provenance));
}

export async function observeDelivery(attempt: DeliveryAttempt, observation: DeliveryObservation, provenance: TrustedSenderProvenance, now = new Date()): Promise<DeliveryAttempt> {
  const current = await authenticateAttempt(attempt, provenance);
  if (current.senderId !== provenance.senderId || current.senderAccountId !== provenance.accountId || current.senderSessionId !== provenance.sessionId) throw new Error("UNAUTHENTICATED_DELIVERY_ATTEMPT");
  if (current.state !== "submitted" && current.state !== "observed_in_chat") return current;
  if (observation.chatId !== current.targetChatId) return advanceDelivery(current, "uncertain", "target_mismatch", provenance, now);
  if (observation.sender !== current.senderId) return advanceDelivery(current, "uncertain", "sender_unverified", provenance, now);
  if (observation.type !== 1 || await payloadDigest(observation.content) !== current.payloadDigest) return advanceDelivery(current, "uncertain", "payload_mismatch", provenance, now);
  const observed = await advanceDelivery(current, "observed_in_chat", "target_sender_and_payload_match", provenance, now);
  const confirmed = await advanceDelivery(observed, "confirmed", "observation_confirmed", provenance, now);
  const { integrityTag: _integrityTag, ...unsigned } = confirmed;
  return validateAttempt(await buildAttempt({ ...unsigned, observedLocalId: observation.localId }, provenance));
}

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState, reason?: DeliveryCause): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  return EDGE_CAUSES.get(`${from}:${to}`)?.has(reason ?? ("" as DeliveryCause)) === true;
}
