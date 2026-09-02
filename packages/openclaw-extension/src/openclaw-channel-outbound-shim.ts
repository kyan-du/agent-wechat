/**
 * Typecheck shim for `openclaw/plugin-sdk/channel-outbound`.
 *
 * Runtime still imports that 2026.8.2 subpath (esbuild leaves `openclaw` external).
 * CI typecheck installs `openclaw@^2026.5.12`, which only has `channel-message`
 * and `channel-reply-pipeline`. Map the new specifier onto those existing types.
 */
export { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-message";
export { createChannelReplyPipeline as createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
