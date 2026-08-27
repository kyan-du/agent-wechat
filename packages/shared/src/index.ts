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
  createAuthenticatedSenderBoundary,
  createQueuedDelivery,
  issueTrustedSenderProvenance,
  deliveryAfterSend,
  observeDelivery,
  payloadDigest,
  type AuthenticatedSenderBoundary,
  type AuthenticatedSenderIdentity,
  type AuthenticatedSessionCapability,
  type DeliveryAttempt,
  type DeliveryCause,
  type DeliveryObservation,
  type DeliveryState,
  type TrustedSenderProvenance,
} from "./delivery-domain.js";

export {
  createAuthenticatedSessionAdapter,
  createAuthenticatedSessionStore,
  restoreAuthenticatedSessionAdapter,
  type AuthenticatedSessionAdapter,
  type AuthenticatedSessionRecord,
  type AuthenticatedSessionStore,
  type AuthenticatedSessionStoreBackend,
  type AuthenticatedSessionStoreSnapshot,
} from "./authenticated-session.js";

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
  deliveryAttemptSchema,
  // Agent config schema
  agentConfigSchema,
} from "./schemas/index.js";
