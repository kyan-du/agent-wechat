---
"@kyan-du/agent-wechat-openclaw": patch
---

Fix plugin load on OpenClaw 2026.10.3: import group-policy helpers from `openclaw/plugin-sdk/runtime-group-policy` instead of the removed `config-runtime` subpath, and inline sender command authorization now that `openclaw/plugin-sdk/command-auth` is gone.
