---
"@kyan-du/agent-wechat-openclaw": minor
---

Rename the OpenClaw channel/plugin id from `wechat` to `agent-wechat`.

OpenClaw 2026.7+ resolves outbound and cron channel names through the official catalog first. Catalog aliases `wechat` / `weixin` / `微信` map to `@tencent-weixin/openclaw-weixin`, so `openclaw channels login --channel wechat` and cron `delivery.channel=wechat` never reached this plugin.

This plugin now registers as `agent-wechat` with no catalog-colliding aliases. `resolveWeChatAccount` still reads `channels.wechat` as a one-release fallback.

After upgrading, reconfigure OpenClaw:

- `plugins.entries.agent-wechat.enabled=true` (remove `plugins.entries.wechat` / leftover `openclaw-weixin`)
- move `channels.wechat` → `channels.agent-wechat`
- set cron `delivery.channel=agent-wechat`
- `openclaw channels login --channel agent-wechat`
- restart the gateway
