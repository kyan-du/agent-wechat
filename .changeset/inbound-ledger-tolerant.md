---
"@kyan-du/agent-wechat-openclaw": patch
---

Inbound ledger no longer locks the WeChat channel because of one oversized entry: writes bound `messageKey`, `chatId` and error codes (prefix + sha256) so they always pass validation, and loads drop invalid or duplicate entries with a warning instead of quarantining the whole ledger.
