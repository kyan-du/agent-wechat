# @kyan-du/agent-wechat-shared

## 0.1.1

### Patch Changes

- [#4](https://github.com/kyan-du/agent-wechat/pull/4) [`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037) Thanks [@kyan-du](https://github.com/kyan-du)! - Add a bounded server-side outbound send queue for `/api/messages/send` with conservative spacing, jitter for burst smoothing, queued-task expiry, short-lived `idempotencyKey` replay, explicit queue-full responses, and an emergency read-only kill switch.

- [#8](https://github.com/kyan-du/agent-wechat/pull/8) [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095) Thanks [@vangie](https://github.com/vangie)! - Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

  - Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
  - Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
  - Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
  - Reconnect catch-up stays `read-only` unless `catchUpMode` is exactly `latest`. Auto-replies are capped at `catchUpChatBudget` chats (default 5), one per poll; leftovers stay held until the budget is raised or a human handles them
  - Security popups pause outbound; resume via POST /api/status/outbound/resume

## 0.1.1-next.0

### Patch Changes

- [#4](https://github.com/kyan-du/agent-wechat/pull/4) [`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037) Thanks [@kyan-du](https://github.com/kyan-du)! - Add a bounded server-side outbound send queue for `/api/messages/send` with conservative spacing, jitter for burst smoothing, queued-task expiry, short-lived `idempotencyKey` replay, explicit queue-full responses, and an emergency read-only kill switch.

- [#8](https://github.com/kyan-du/agent-wechat/pull/8) [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095) Thanks [@vangie](https://github.com/vangie)! - Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

  - Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
  - Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
  - Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
  - Reconnect catch-up stays `read-only` unless `catchUpMode` is exactly `latest`. Auto-replies are capped at `catchUpChatBudget` chats (default 5), one per poll; leftovers stay held until the budget is raised or a human handles them
  - Security popups pause outbound; resume via POST /api/status/outbound/resume
