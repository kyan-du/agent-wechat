import type { Message, SendResult } from "./types/index.js";

export const DELIVERY_DOMAIN_SCHEMA_VERSION = 1 as const;
export type DeliveryState = "queued" | "composing" | "submitted" | "observed_in_chat" | "confirmed" | "uncertain" | "failed";
export type AuthenticatedSenderIdentity = { readonly accountId: string; readonly sessionId: string; readonly senderId: string };
export type DeliveryCause = "send_accepted" | "target_sender_and_payload_match" | "observation_confirmed" | "target_mismatch" | "sender_unverified" | "payload_mismatch" | "pre_commit_failure" | "post_commit_uncertain";

export type DeliveryAttempt = {
  schemaVersion: typeof DELIVERY_DOMAIN_SCHEMA_VERSION;
  targetChatId: string;
  payloadDigest: string;
  state: DeliveryState;
  commitAttempted: boolean;
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
  const createdAt = Date.parse(attempt.createdAt);
  const updatedAt = Date.parse(attempt.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt < createdAt) throw new Error("INVALID_DELIVERY_TIME");
  const lastTransition = attempt.transitions.at(-1);
  if (attempt.transitions.length === 0 && attempt.state !== "queued") throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (lastTransition && lastTransition.to !== attempt.state) throw new Error("INVALID_DELIVERY_TRANSITION_TAIL");
  if (attempt.observedLocalId !== undefined && !["observed_in_chat", "confirmed"].includes(attempt.state)) throw new Error("INVALID_DELIVERY_OBSERVATION_STATE");
  for (let index = 0; index < attempt.transitions.length; index += 1) {
    const transition = attempt.transitions[index]!;
    const previous = attempt.transitions[index - 1];
    if (previous && transition.from !== previous.to) throw new Error("INVALID_DELIVERY_TRANSITION_CHAIN");
    if (previous && Date.parse(transition.at) < Date.parse(previous.at)) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (index === 0 && Date.parse(transition.at) < createdAt) throw new Error("INVALID_DELIVERY_TRANSITION_TIME");
    if (Date.parse(transition.at) > updatedAt || !canAdvanceDelivery(transition.from, transition.to, transition.reason)) throw new Error("INVALID_DELIVERY_TRANSITION_EDGE");
    if (transition.to === "uncertain" && transition.reason === "post_commit_uncertain" && !attempt.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
    if (transition.to === "failed" && transition.reason === "pre_commit_failure" && attempt.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  }
  return Object.freeze({ ...attempt, transitions: Object.freeze(attempt.transitions.map((transition) => Object.freeze({ ...transition }))) });
}

export async function createQueuedDelivery(targetChatId: string, payload: string, now = new Date(), idempotencyKey?: string): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  return validateAttempt({ schemaVersion: 1, targetChatId, payloadDigest: await payloadDigest(payload), state: "queued", commitAttempted: false, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [] });
}

export async function advanceDelivery(attempt: DeliveryAttempt, to: DeliveryState, reason: DeliveryCause, now = new Date()): Promise<DeliveryAttempt> {
  const current = validateAttempt(attempt);
  if (to === "uncertain" && reason === "post_commit_uncertain" && !current.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  if (to === "failed" && reason === "pre_commit_failure" && current.commitAttempted) throw new Error("INVALID_DELIVERY_COMMIT_EVIDENCE");
  if (!canAdvanceDelivery(current.state, to, reason)) return current;
  const timestamp = now.toISOString();
  return validateAttempt({ ...current, state: to, updatedAt: timestamp, transitions: [...current.transitions, { from: current.state, to, at: timestamp, reason }] });
}

export async function deliveryAfterSend(result: Pick<SendResult, "success" | "commitAttempted">, targetChatId: string, payload: string, now: Date, idempotencyKey?: string): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  const state: DeliveryState = result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed";
  const reason: DeliveryCause = result.success ? "send_accepted" : result.commitAttempted ? "post_commit_uncertain" : "pre_commit_failure";
  return validateAttempt({ schemaVersion: 1, targetChatId, payloadDigest: await payloadDigest(payload), state, commitAttempted: result.commitAttempted === true, createdAt: timestamp, updatedAt: timestamp, ...(idempotencyKey ? { idempotencyKey } : {}), transitions: [{ from: "queued", to: state, at: timestamp, reason }] });
}

export async function observeDelivery(attempt: DeliveryAttempt, observation: DeliveryObservation, now = new Date()): Promise<DeliveryAttempt> {
  const current = validateAttempt(attempt);
  if (current.state !== "submitted" && current.state !== "observed_in_chat") return current;
  if (observation.chatId !== current.targetChatId) return advanceDelivery(current, "uncertain", "target_mismatch", now);
  if (observation.type !== 1 || await payloadDigest(observation.content) !== current.payloadDigest) return advanceDelivery(current, "uncertain", "payload_mismatch", now);
  const observed = await advanceDelivery(current, "observed_in_chat", "target_sender_and_payload_match", now);
  const confirmed = await advanceDelivery(observed, "confirmed", "observation_confirmed", now);
  return Object.freeze({ ...confirmed, observedLocalId: observation.localId });
}

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState, reason?: DeliveryCause): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  return EDGE_CAUSES.get(`${from}:${to}`)?.has(reason ?? ("" as DeliveryCause)) === true;
}
