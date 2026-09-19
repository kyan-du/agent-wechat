---
"@kyan-du/agent-wechat-agent-server": patch
---

Resolve nested 聊天记录 images via `msg/attach/<chat>/<yyyy-mm>/Rec/*/Img/{file}` hardlink paths (bare `0`/`1`/`2` without `.dat`); remove the ineffective HTTP CDN nested-image fallback.
