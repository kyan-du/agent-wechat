---
"@kyan-du/agent-wechat-openclaw": patch
"@kyan-du/agent-wechat-agent-server": patch
---

Do not treat WeChat merged-forward / 聊天记录 cards as failed media downloads. Chat history keeps its `[Chat History]` text instead of appending `MEDIA_UNSUPPORTED`. Nested local images (`datatype=2`) and files (`datatype=8`) inside the record are decrypted when a `.dat`/file is on disk and attached as multiple inbound `MediaPaths`. CDN-only nested items without a local file are skipped. Voice/video nested items are not attached. File attachments (appmsg subtype 6) still poll.
