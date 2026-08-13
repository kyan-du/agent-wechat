---
"@agent-wechat/cli": minor
"@agent-wechat/wechat": minor
"@agent-wechat/shared": patch
---

Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

- Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
- Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
- Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
- Reconnect catch-up stays `read-only` unless `catchUpMode` is exactly `latest`. Auto-replies are capped at `catchUpChatBudget` chats (default 5), one per poll; leftovers stay held until the budget is raised or a human handles them
- Security popups pause outbound; resume via POST /api/status/outbound/resume
