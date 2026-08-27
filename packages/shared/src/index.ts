// Export types from types module
export * from "./types/index.js";

export {
  MESSAGE_DOMAIN_SCHEMA_VERSION,
  compareMessageCursor,
  messageCursor,
  messageEnvelopes,
  messageIdentityKey,
  type MessageCursor,
  type MessageEnvelope,
} from "./message-domain.js";

export {
  DELIVERY_DOMAIN_SCHEMA_VERSION,
  advanceDelivery,
  canAdvanceDelivery,
  createQueuedDelivery,
  isAllowedEdge,
  deliveryAfterSend,
  observeDelivery,
  payloadDigest,
  type AuthenticatedSenderIdentity,
  type DeliveryAttempt,
  type DeliveryCause,
  type DeliveryInitialOutcome,
  type DeliveryObservation,
  type DeliveryState,
} from "./delivery-domain.js";

// Export HTTP client
export {
  WeChatClient,
  WeChatHttpError,
  type WeChatClientOptions,
  type StatusResponse,
  type AuthStatus,
  type CursorPage,
} from "./client.js";

// Export schemas (but not the inferred types which duplicate types/)
export {
  // Container lifecycle schemas
  upParamsSchema,
  upResultSchema,
  statusSchema,
  // Authentication schemas
  loginStateSchema,
  loginResultSchema,
  loginSubscriptionEventSchema,
  // Chat schemas
  chatSchema,
  listChatsParamsSchema,
  findChatParamsSchema,
  getChatParamsSchema,
  openChatParamsSchema,
  openChatResultSchema,
  // Message schemas
  messageSchema,
  listMessagesParamsSchema,
  sendParamsSchema,
  sendResultSchema,
  getMediaParamsSchema,
  mediaResultSchema,
  deliveryStateSchema,
  deliveryTransitionSchema,
  deliveryInitialOutcomeSchema,
  deliveryAttemptSchema,
  deliveryObservationSchema,
  // Agent config schema
  agentConfigSchema,
} from "./schemas/index.js";
