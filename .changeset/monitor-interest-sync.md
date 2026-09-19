---
"@kyan-du/agent-wechat-openclaw": patch
"@kyan-du/agent-wechat-agent-server": patch
---

Sync OpenClaw allowlist interest to agent-server (`PUT/GET /api/interest`) and filter `listChats?interestOnly=true` so denied DMs stay out of the monitor poll without clearing WeChat badges. Only enable `interestOnly` after a successful server sync; re-GET each tick so an agent-server restart (in-memory wipe) triggers re-PUT.
