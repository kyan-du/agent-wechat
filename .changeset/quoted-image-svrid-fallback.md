---
"@kyan-du/agent-wechat-agent-server": patch
---

Resolve 「回复」 quoted images via refermsg svrid when hardlink/md5 misses: look up the original type-3 message in the same chat and materialize it through the normal resource-db path. Reply context shows `[Image]` instead of raw img XML.
