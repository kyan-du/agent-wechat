---
"@kyan-du/agent-wechat-agent-server": patch
---

Attach nested images inside WeChat 聊天记录 / merged-forward cards when local hardlink `.dat` is missing: also look up `.dat` by md5 filename, then fall back to downloading `cdnbigimgurl` / `cdnmidimgurl` / `cdnthumburl` (decrypt with dataitem `aeskey` when the body is not already an image).
