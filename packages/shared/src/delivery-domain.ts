import type { Message, SendResult } from "./types/index.js";

export const DELIVERY_DOMAIN_SCHEMA_VERSION = 1 as const;

export type DeliveryState =
  | "queued"
  | "composing"
  | "submitted"
  | "observed_in_chat"
  | "confirmed"
  | "uncertain"
  | "failed";

export type DeliveryAttempt = {
  schemaVersion: typeof DELIVERY_DOMAIN_SCHEMA_VERSION;
  idempotencyKey?: string;
  targetChatId: string;
  payloadDigest: string;
  state: DeliveryState;
  commitAttempted: boolean;
  createdAt: string;
  updatedAt: string;
  observedLocalId?: number;
  transitions: DeliveryTransition[];
};

export type DeliveryObservation = Pick<Message, "chatId" | "localId" | "serverId" | "timestamp" | "type" | "sender" | "content">;

export type DeliveryTransition = { from: DeliveryState; to: DeliveryState; at: string; reason?: string };

export async function payloadDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deliveryAfterSend(
  result: Pick<SendResult, "success" | "commitAttempted">,
  targetChatId: string,
  payload: string,
  now = new Date(),
  idempotencyKey?: string,
): Promise<DeliveryAttempt> {
  const timestamp = now.toISOString();
  const digest = await payloadDigest(payload);
  return {
    schemaVersion: DELIVERY_DOMAIN_SCHEMA_VERSION,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    targetChatId,
    payloadDigest: digest,
    state: result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed",
    commitAttempted: result.commitAttempted === true,
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: [{ from: "queued", to: result.success ? "submitted" : result.commitAttempted ? "uncertain" : "failed", at: timestamp }],
  };
}

export async function observeDelivery(
  attempt: DeliveryAttempt,
  observation: DeliveryObservation,
  now = new Date(),
): Promise<DeliveryAttempt> {
  if (attempt.state !== "submitted" && attempt.state !== "observed_in_chat") return { ...attempt };
  if (observation.chatId !== attempt.targetChatId) return transition(attempt, "uncertain", now, "target_mismatch");
  const observedPayload = observation.content.trim();
  if (!observedPayload || await payloadDigest(observedPayload) !== attempt.payloadDigest) {
    return transition(attempt, "uncertain", now, "payload_mismatch");
  }
  return { ...transition(attempt, "confirmed", now), observedLocalId: observation.localId };
}

function transition(attempt: DeliveryAttempt, to: DeliveryState, now: Date, reason?: string): DeliveryAttempt {
  if (!canAdvanceDelivery(attempt.state, to)) return { ...attempt };
  return { ...attempt, state: to, updatedAt: now.toISOString(), transitions: [...attempt.transitions, { from: attempt.state, to, at: now.toISOString(), ...(reason ? { reason } : {}) }] };
}

export function canAdvanceDelivery(from: DeliveryState, to: DeliveryState): boolean {
  const order: DeliveryState[] = ["queued", "composing", "submitted", "observed_in_chat", "confirmed"];
  const terminal = new Set<DeliveryState>(["confirmed", "uncertain", "failed"]);
  if (terminal.has(from)) return false;
  if (to === "uncertain" || to === "failed") return true;
  return order.indexOf(to) > order.indexOf(from);
}
