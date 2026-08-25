// ============================================
// Generated types (from Rust via ts-rs)
// Run `./scripts/generate-types.sh` to regenerate
// ============================================

export type { Chat } from "./generated/Chat.js";
export type { Contact } from "./generated/Contact.js";
export type { GroupMember } from "./generated/GroupMember.js";
export type { Message } from "./generated/Message.js";
export type { LoginSubscriptionEvent } from "./generated/LoginSubscriptionEvent.js";
export type { SendParams } from "./generated/SendParams.js";
export type { ImageData } from "./generated/ImageData.js";
export type { FileData } from "./generated/FileData.js";
export type { OpenChatResult } from "./generated/OpenChatResult.js";

// ============================================
// CONTAINER LIFECYCLE
// ============================================

export interface UpParams {
  image?: string;
}

export interface UpResult {
  url: string;
}

export interface Status {
  container: "running" | "stopped" | "unknown";
  loginState: LoginState;
  version: string;
}

// ============================================
// AUTHENTICATION
// ============================================

export type LoginState =
  | { status: "logged_out" }
  | { status: "qr_pending"; qrDataUrl?: string }
  | { status: "logged_in"; userId?: string };

export interface LoginResult {
  success: boolean;
  state: LoginState;
}

// ============================================
// CHATS (params only — Chat type is generated)
// ============================================

export interface ListChatsParams {
  limit?: number;
}

export interface FindChatParams {
  name: string;
}

export interface GetChatParams {
  id: string;
}

export interface OpenChatParams {
  chatId: string;
}

// ============================================
// MESSAGES (params only — Message type is generated)
// ============================================

export interface ListMessagesParams {
  chatId: string;
  limit?: number;
  offset?: number;
}

// Note: SendResult kept handwritten (has messageId field not yet in Rust)
export interface SendResult {
  success: boolean;
  messageId?: string;
  errorCode?: string;
  error?: string;
  commitAttempted?: boolean;
}

export interface GetMediaParams {
  chatId: string;
  localId: number;
}

// Note: MediaResult kept handwritten (Rust uses plain string for type,
// TS has richer string literal union)
export interface MediaResult {
  type: "image" | "emoji" | "voice" | "file" | "video" | "pending" | "unsupported";
  data?: string;      // base64 for image/voice/file
  url?: string;       // CDN URL for emoji
  format: string;
  filename: string;
  source?: "original" | "thumbnail";
  errorCode?: string;
}

// ============================================
// EVENTS
// ============================================

export interface LoginEvent {
  type: "login";
  state: LoginState;
}

export type ServerEvent = LoginEvent;

// ============================================
// AGENT CONFIGURATION
// ============================================

export interface AgentConfig {
  maxTurns: number;
  turnTimeout: number;
  totalTimeout: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTurns: 30,
  turnTimeout: 60_000,
  totalTimeout: 600_000,
};

// ============================================
// STREAMING (stubbed for future)
// ============================================

export interface ScreenFrame {
  frame: string; // base64 JPEG
  timestamp: number;
  width: number;
  height: number;
}

export interface RTCSignal {
  type: "offer" | "answer" | "ice";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface StreamConfig {
  screen?: {
    enabled: boolean;
    fps: number;
    quality: number;
    region?: { x: number; y: number; w: number; h: number };
  };
  audio?: {
    enabled: boolean;
    codec: "opus";
    sampleRate: 48000;
    channels: 1 | 2;
    echoCancellation: boolean;
    noiseSuppression: boolean;
  };
}
