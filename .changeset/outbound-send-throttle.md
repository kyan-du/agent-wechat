---
"@agent-wechat/agent-server": patch
"@agent-wechat/shared": patch
---

Add a bounded server-side outbound send queue for `/api/messages/send` with conservative spacing, jitter for burst smoothing, queued-task expiry, short-lived `idempotencyKey` replay, explicit queue-full responses, and an emergency read-only kill switch.
