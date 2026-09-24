---
"@kyan-du/agent-wechat-cli": patch
"@kyan-du/agent-wechat-openclaw": patch
"@kyan-du/agent-wechat-wechaty-puppet": patch
"@kyan-du/agent-wechat-wechaty-gateway": patch
"@kyan-du/agent-wechat-agent-server": patch
---

Fix WeChat Linux 4.1.13.23 chat open on ARM64: activate the main window before clicks, select by visible UI list order (not Frida vector index), and reject unverified openChat HTTP 200 responses in the OpenClaw plugin.
