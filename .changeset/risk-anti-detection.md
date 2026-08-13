---
"@agent-wechat/cli": minor
"@agent-wechat/wechat": minor
"@agent-wechat/shared": patch
---

Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

- Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
- Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
- Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
- Reconnect folds by chat and stays paced (one send per poll) until the backlog drains
- Security popups pause outbound; resume via POST /api/status/outbound/resume
