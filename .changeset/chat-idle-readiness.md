---
"@kyan-du/agent-wechat-agent-server": patch
---

Report logged-in idle chat list as `chat_idle` instead of `composer_unavailable` / `COMPOSER_UNAVAILABLE`, so `wx status` and `/api/status` can tell "no conversation selected" apart from a missing composer after open/focus.
