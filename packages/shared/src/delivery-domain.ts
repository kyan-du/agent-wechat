import { deliveryAttemptSchema, deliveryObservationSchema } from "./schemas/index.js";
import type { Message, SendResult } from "./types/index.js";

export const DELIVERY_DOMAIN_SCHEMA_VERSION = 1 as const;
export type DeliveryState = "queued" | "composing" | "submitted" | "observed_in_chat" | "confirmed" | "uncertain" | "failed";
export type AuthenticatedSenderIdentity = { readonly accountId: string; readonly sessionId: string; readonly senderId: string };
export type DeliveryCause = "send_accepted" | "target_sender_and_payload_match" | "observation_confirmed" | "target_mismatch" | "sender_unverified" | "payload_mismatch" | "pre_commit_failure" | "post_commit_uncertain";

export type DeliveryInitialOutcome = {
  readonly source: "send_result";
  readonly success: boolean;
  readonly commitAttempted: boolean;
};
export type DeliveryAttempt = {
  schemaVersion: typeof DELIVERY_DOMAIN_SCHEMA_VERSION;
  senderId: string;
  targetChatId: string;
  payloadDigest: string;
  state: DeliveryState;
  commitAttempted: boolean;
  initialOutcome?: DeliveryInitialOutcome;
  createdAt: string;
  updatedAt: string;
  observedLocalId?: number;
  transitions: readonly DeliveryTransition[];
  idempotencyKey?: string;
};
export type DeliveryObservation = Pick<Message, "chatId" | "localId" | "serverId" | "timestamp" | "type" | "sender" | "content">;
export type DeliveryTransition = { from: DeliveryState; to: DeliveryState; at: string; reason: DeliveryCause };

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

function validateAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  const parsed = deliveryAttemptSchema.strict().parse(attempt);
  const createdAt = Date.parse(parsed.createdAt);
  const updatedAt = Date.parse(parsed.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt < createdAt) throw new Error("INVALID_DELIVERY_TIME");
  const lastTransition = parsed.transitions.at(-1);
  if (parsed.transitions.length === 0 && parsed.state !== "queued") throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (parsed.transitions.length > 0 && parsed.state === "queued") throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME");
  if (parsed.state === "queued" && parsed.initialOutcome !== undefined) throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME");
  const firstTransition = parsed.transitions[0];
  if (parsed.state !== "queued" && parsed.state !== "composing") {
    const outcome = parsed.initialOutcome;
    if (outcome?.source !== "send_result") throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY");
    if (outcome.commitAttempted !== parsed.commitAttempted) throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME");
  }
  if (firstTransition?.from === "queued" && ["submitted", "uncertain", "failed"].includes(firstTransition.to)) {
    const expected = firstTransition.to === "submitted" ? "send_accepted" : firstTransition.to === "uncertain" ? "post_commit_uncertain" : "pre_commit_failure";
    const outcome = parsed.initialOutcome;
    if (expected !== firstTransition.reason || outcome?.success !== (firstTransition.to === "submitted") || outcome?.commitAttempted !== parsed.commitAttempted || (firstTransition.to === "uncertain" && !parsed.commitAttempted) || (firstTransition.to === "failed" && parsed.commitAttempted)) throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME");
  }
  if (lastTransition && lastTransition.to !== parsed.state) throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (parsed.observedLocalId !== undefined && !["observed_in_chat", "confirmed"].includes(parsed.state)) throw new Error("INVALID_DELIVERY_OBSERVATION_STATE");
  for (let index = 0; index < parsed.transitions.length; index += 1) {
    const transition = parsed.transitions[index]!;
    const previous = parsed.transitions[index - 1];
    if (previous && transition.from !== previous.to) throw new Error("INVALID_DELIVERY_TRANSITION_CHAIN");
    if (previous && Date.parse(transition.at) < Date.parse(previous.at)) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (index === 0 && Date.parse(transition.at) < createdAt) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (Date.parse(transition.at) > updatedAt || !isAllowedEdge(transition.from, transition.to, transition.reason, parsed.commitAttempted)) throw new Error("INVALID_DELIVERY_TRANSITION_EDGE");
    if (transition.to === "uncertain" && transition.reason === "post_commit_uncertain" && !parsed.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
    if (transition.to === "failed" && transition.reason === "pre_commit_failure" && parsed.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  }
  return Object.freeze({ ...parsed, transitions: Object.freeze(parsed.transitions.map((transition) => Object.freeze({ ...transition }))) });
}

export async function createQueuedDelivery(targetChatId: string, payload: string, senderId: string, now = new Date(), idempotencyKey?: string): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  return validateAttempt({ schemaVersion: 1, senderId, targetChatId, payloadDigest: await payloadDigest(payload), state: "queued", commitAttempted: false, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [] });
}

export async function advanceDelivery(attempt: DeliveryAttempt, to: DeliveryState, reason: DeliveryCause, now = new Date()): Promise<DeliveryAttempt> {
  const current = validateAttempt(attempt);
  if (to === "uncertain" && reason === "post_commit_uncertain" && !current.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  if ((to === "failed" || to === "uncertain") && (current.state === "queued" || current.state === "composing") && current.initialOutcome === undefined) {
    throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY");
  }
  if (to === "submitted" && current.state === "composing" && current.initialOutcome === undefined) throw new Error("INVALID_DELIVERY_INITIAL_OUTCOME_AUTHORITY");
  if (!canAdvanceDelivery(current.state, to, reason, current.commitAttempted)) return current;
  const timestamp = now.toISOString();
  const next = validateAttempt({ ...current, state: to, updatedAt: timestamp, transitions: [...current.transitions, { from: current.state, to, at: timestamp, reason }] });
  return next;
}

export async function deliveryAfterSend(result: Pick<SendResult, "success" | "commitAttempted">, targetChatId: string, payload: string, senderId: string, now: Date, idempotencyKey?: string): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  const state: DeliveryState = result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed";
  const reason: DeliveryCause = result.success ? "send_accepted" : result.commitAttempted ? "post_commit_uncertain" : "pre_commit_failure";
  return validateAttempt({ schemaVersion: 1, senderId, targetChatId, payloadDigest: await payloadDigest(payload), state, commitAttempted: result.commitAttempted === true, initialOutcome: { source: "send_result", success: result.success, commitAttempted: result.commitAttempted === true }, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [{ from: "queued", to: state, at: timestamp, reason }] });
}

export async function observeDelivery(attempt: DeliveryAttempt, observation: DeliveryObservation, now = new Date()): Promise<DeliveryAttempt> {
  const current = validateAttempt(attempt);
  const checkedObservation = deliveryObservationSchema.strict().parse(observation);
  if (current.state !== "submitted" && current.state !== "observed_in_chat") return current;
  const observationAt = Date.parse(checkedObservation.timestamp);
  const nowAt = now.getTime();
  if (!Number.isFinite(observationAt) || !Number.isFinite(nowAt) || observationAt < Date.parse(current.createdAt) || observationAt > nowAt) throw new Error("INVALID_DELIVERY_OBSERVATION_TIME");
  if (checkedObservation.chatId !== current.targetChatId) return advanceDelivery(current, "uncertain", "target_mismatch", now);
  if (checkedObservation.sender !== current.senderId) return advanceDelivery(current, "uncertain", "sender_unverified", now);
  if (normalizeDeliveryType(checkedObservation.type) !== 1 || await payloadDigest(checkedObservation.content) !== current.payloadDigest) return advanceDelivery(current, "uncertain", "payload_mismatch", now);
  const observed = await advanceDelivery(current, "observed_in_chat", "target_sender_and_payload_match", now);
  const confirmed = await advanceDelivery(observed, "confirmed", "observation_confirmed", now);
  return validateAttempt({ ...confirmed, observedLocalId: checkedObservation.localId });
}

function normalizeDeliveryType(type: number): number {
  return (type % 0x1_0000_0000) & 0x7fff_ffff;
}

export function isAllowedEdge(from: DeliveryState, to: DeliveryState, reason?: DeliveryCause, commitAttempted?: boolean): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  if (reason === "post_commit_uncertain" && commitAttempted !== true) return false;
  if (reason === "pre_commit_failure" && commitAttempted !== false) return false;
  return EDGE_CAUSES.get(`${from}:${to}`)?.has(reason ?? ("" as DeliveryCause)) === true;
}

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState, reason?: DeliveryCause, commitAttempted?: boolean): boolean {
  return isAllowedEdge(from, to, reason, commitAttempted);
}
