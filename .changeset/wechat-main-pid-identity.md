---
"@kyan-du/agent-wechat-cli": patch
"@kyan-du/agent-wechat-openclaw": patch
"@kyan-du/agent-wechat-wechaty-puppet": patch
"@kyan-du/agent-wechat-wechaty-gateway": patch
"@kyan-du/agent-wechat-agent-server": patch
---

Identify the live WeChat main process from `/proc` identity instead of `pgrep -f` path substrings, so crashpad helpers are not selected during login passphrase capture. When `message_resource.db` exists on disk, require a working stored key so a stale credential re-extracts; a missing file does not retry.
