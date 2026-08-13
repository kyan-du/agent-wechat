---
"@agent-wechat/cli": minor
"@agent-wechat/wechat": minor
"@agent-wechat/shared": patch
---

Lower the chance WeChat treats this official-client container as a bot.

- Persistent per-instance device identity (machine-id, hostname, MAC); drop `/.dockerenv`
- Human-paced outbound queue: reading/typing delay, chat cooldown, budgets, quiet hours, kill switch
- Skip Frida on same-chat consecutive sends; security popups freeze outbound
- Reconnect catch-up folds by chat instead of one reply per missed message
