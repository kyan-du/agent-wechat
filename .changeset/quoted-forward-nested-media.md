---
"@kyan-du/agent-wechat-agent-server": patch
"@kyan-du/agent-wechat-openclaw": patch
---

Attach nested and quoted media in one path: 聊天记录 / 引用 / 引用转发 resolve local image, file, voice, and video (datatype 2/3/4/8 and type 34/43). Missing Rec files stay retryable `CHAT_HISTORY_NOT_MATERIALIZED` without dropping already-resolved items. Quoted images with a 32-char md5 no longer get `QUOTED_IMAGE_RESOURCE_UNAVAILABLE`. Inbound validation accepts Word `.docx` and converted MP3 voice; raw SILK is not mislabeled as MPEG. Nested payloads require a unique verified full-content hash; Rec prefix/index collisions, thumbnail hashes, and duplicate md5 paths fail closed. Unidentified quoted cards are not clicked. Chat-history polling covers the GUI materialize budget and keeps partial items.
