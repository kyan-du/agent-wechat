---
"@kyan-du/agent-wechat-agent-server": patch
---

Disable outbound quiet hours by default (`AGENT_WECHAT_QUIET_START_MIN`/`END_MIN` = 0/0). Operators can still set a window via env, TOML, or `--outbound-quiet-start`/`--outbound-quiet-end`.
