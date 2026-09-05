---
"@kyan-du/agent-wechat-openclaw": patch
---

Keep newsapp feed delivery, skip other WeChat system chats in the unread monitor, and back off when unreadCount is set but listMessages returns nothing so empty fetches cannot spin the poll loop.
