---
"@agent-wechat/agent-server": patch
---

Render the text and media descriptions inside Combine and Forward messages
(type 49, subtype 19), including nested chat histories. Parse XML entities and
CDATA correctly, retain sender attribution, and label bounded truncation or
unavailable nested records. Forwarded media is described, not downloaded.
