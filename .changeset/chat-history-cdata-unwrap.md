---
"@kyan-du/agent-wechat-agent-server": patch
---

Parse WeChat merged-forward / 聊天记录 cards whose `<recorditem>` payload is wrapped in CDATA (`<![CDATA[<recordinfo>…</recordinfo>]]>`) instead of HTML-entity escaping. Image-only `datatype=2` items without `datatitle`/`datadesc` still become forwarded nodes. Existing entity-escaped recorditem fixtures stay valid. Nested image bytes still require a local `.dat`.
