---
"@kyan-du/agent-wechat-agent-server": patch
"@kyan-du/agent-wechat-openclaw": patch
---

Nested 聊天记录 images: disambiguate Rec `Img/N` by hardlink `file_size`, derive XOR from bare `{n}_t` thumbs, scroll the detail list after opening the card, and rematerialize missing Rec files by left-thumb double-click into Photos (then Escape). Raise chat-history materialize GUI/poll budget to 25s so scroll + Photos clicks fit; keep poll window ≥ that budget. Partial nested `items` no longer forever-`CHAT_HISTORY_NOT_MATERIALIZED`.
