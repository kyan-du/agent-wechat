---
"@kyan-du/agent-wechat-cli": patch
"@kyan-du/agent-wechat-openclaw": patch
"@kyan-du/agent-wechat-wechaty-puppet": patch
"@kyan-du/agent-wechat-wechaty-gateway": patch
"@kyan-du/agent-wechat-agent-server": patch
---

Upgrade the runtime image to WeChat Linux v4.1.13.23. Capture the login passphrase automatically before QR/saved-account login, derive SQLCipher compatibility-4 keys without a hand-placed passphrase file, and pin both architectures to verified Wayback `if_` packages.
