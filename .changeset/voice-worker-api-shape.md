---
"@kyan-du/agent-wechat-agent-server": patch
---

Fix voice-note sending: the voice worker now reads this fork's paged `/api/messages` response (`items`) and string message types, instead of failing every job with "string indices must be integers".
