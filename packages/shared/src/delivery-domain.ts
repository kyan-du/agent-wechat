import { deliveryAttemptSchema } from "./schemas/index.js";
import type { Message, SendResult } from "./types/index.js";

export const DELIVERY_DOMAIN_SCHEMA_VERSION = 1 as const;
export type DeliveryState = "queued" | "composing" | "submitted" | "observed_in_chat" | "confirmed" | "uncertain" | "failed";
export type DeliveryCause = "send_accepted" | "target_sender_and_payload_match" | "observation_confirmed" | "target_mismatch" | "sender_unverified" | "payload_mismatch" | "pre_commit_failure" | "post_commit_uncertain";

export type TrustedSenderProvenance = {
  readonly accountId: string;
  readonly sessionId: string;
  readonly senderId: string;
  readonly verifiedAt: string;
  readonly __trustedSenderProvenance: true;
};

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
};
export type DeliveryObservation = Pick<Message, "chatId" | "localId" | "serverId" | "timestamp" | "type" | "sender" | "content">;
export type DeliveryTransition = { from: DeliveryState; to: DeliveryState; at: string; reason: DeliveryCause };

const DELIVERY_STATES: readonly DeliveryState[] = ["queued", "composing", "submitted", "observed_in_chat", "confirmed", "uncertain", "failed"];
const TRUSTED_PROVENANCES = new WeakSet<object>();
const TERMINAL_STATES = new Set<DeliveryState>(["confirmed", "uncertain", "failed"]);
const TERMINAL_CAUSES = new Set<DeliveryCause>(["target_mismatch", "sender_unverified", "payload_mismatch", "pre_commit_failure", "post_commit_uncertain"]);
const EDGE_CAUSES = new Map<string, DeliveryCause>([
  ["queued:composing", "send_accepted"],
  ["queued:submitted", "send_accepted"],
  ["composing:submitted", "send_accepted"],
  ["submitted:observed_in_chat", "target_sender_and_payload_match"],
  ["observed_in_chat:confirmed", "observation_confirmed"],
]);

export async function payloadDigest(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createTrustedSenderProvenance(accountId: string, sessionId: string, senderId: string, verifiedAt = new Date()): TrustedSenderProvenance {
  if (!accountId.trim() || !sessionId.trim() || !senderId.trim()) throw new Error("INVALID_SENDER_PROVENANCE");
  const provenance = Object.freeze({ accountId, sessionId, senderId, verifiedAt: verifiedAt.toISOString(), __trustedSenderProvenance: true as const });
  TRUSTED_PROVENANCES.add(provenance);
  return provenance;
}

function validateAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  const validated = deliveryAttemptSchema.parse(attempt);
  if (validated.transitions.length === 0 || validated.transitions.at(-1)?.to !== validated.state) throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (validated.observedLocalId !== undefined && !["observed_in_chat", "confirmed"].includes(validated.state)) throw new Error("INVALID_DELIVERY_OBSERVATION_STATE");
  if (Date.parse(validated.updatedAt) < Date.parse(validated.createdAt)) throw new Error("INVALID_DELIVERY_TIME");
  for (let index = 0; index < validated.transitions.length; index += 1) {
    const transition = validated.transitions[index]!;
    if (index > 0) {
      const previous = validated.transitions[index - 1]!;
      if (transition.from !== previous.to) throw new Error("INVALID_DELIVERY_TRANSITION_CHAIN");
      if (Date.parse(transition.at) < Date.parse(previous.at)) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    }
    if (index === 0 && Date.parse(transition.at) < Date.parse(validated.createdAt)) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (!canAdvanceDelivery(transition.from, transition.to, transition.reason)) throw new Error("INVALID_DELIVERY_TRANSITION_EDGE");
  }
  return validated;
}

export function advanceDelivery(attempt: DeliveryAttempt, to: DeliveryState, reason: DeliveryCause, now = new Date()): DeliveryAttempt {
  const current = validateAttempt(attempt);
  if (!DELIVERY_STATES.includes(to) || !canAdvanceDelivery(current.state, to, reason)) return current;
  return validateAttempt({ ...current, state: to, updatedAt: now.toISOString(), transitions: [...current.transitions, { from: current.state, to, at: now.toISOString(), reason }] });
}

export async function deliveryAfterSend(result: Pick<SendResult, "success" | "commitAttempted">, targetChatId: string, payload: string, now = new Date(), idempotencyKey: string | undefined, provenance: TrustedSenderProvenance): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  const state: DeliveryState = result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed";
  const reason: DeliveryCause = result.success ? "send_accepted" : result.commitAttempted ? "post_commit_uncertain" : "pre_commit_failure";
  if (!TRUSTED_PROVENANCES.has(provenance)) throw new Error("UNTRUSTED_SENDER_PROVENANCE");
  return validateAttempt({ schemaVersion: 1, senderId: provenance.senderId, senderAccountId: provenance.accountId, senderSessionId: provenance.sessionId, targetChatId, payloadDigest: await payloadDigest(payload), state, commitAttempted: result.commitAttempted === true, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [{ from: "queued", to: state, at: timestamp, reason }] });
}

export async function observeDelivery(attempt: DeliveryAttempt, observation: DeliveryObservation, now = new Date()): Promise<DeliveryAttempt> {
  const current = validateAttempt(attempt);
  if (current.state !== "submitted" && current.state !== "observed_in_chat") return current;
  if (observation.chatId !== current.targetChatId) return advanceDelivery(current, "uncertain", "target_mismatch", now);
  if (observation.sender !== current.senderId) return advanceDelivery(current, "uncertain", "sender_unverified", now);
  if (observation.type !== 1 || await payloadDigest(observation.content) !== current.payloadDigest) return advanceDelivery(current, "uncertain", "payload_mismatch", now);
  const observed = advanceDelivery(current, "observed_in_chat", "target_sender_and_payload_match", now);
  return { ...advanceDelivery(observed, "confirmed", "observation_confirmed", now), observedLocalId: observation.localId };
}

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState, reason?: DeliveryCause): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  if (to === "uncertain" || to === "failed") return reason !== undefined && TERMINAL_CAUSES.has(reason);
  return EDGE_CAUSES.get(`${from}:${to}`) === reason;
}
