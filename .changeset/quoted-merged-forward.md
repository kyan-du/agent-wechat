---
"@kyan-du/agent-wechat-agent-server": patch
---

Parse WeChat quote/reply (`<refermsg>`) of merged-forward / 聊天记录 cards: unwrap the entity-escaped (and CDATA) payload in `refermsg/content`, populate `forwarded.nodes`, and route media through the same nested dataitem path as a direct forward. Plain quoted images still report `QUOTED_IMAGE_RESOURCE_UNAVAILABLE`. Nested image bytes still require a local `.dat`.
