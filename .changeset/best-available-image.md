---
"@kyan-du/agent-wechat-agent-server": patch
---

Return the best available image instead of the cached thumbnail (port of upstream a71cf8b/9f524a5): try the original `_h.dat`, then the standard `.dat`, then `_t.dat`, each decrypted independently, and fall back to the cached Thumb `.jpg` only when none decode. The `source` field keeps its `original` / `thumbnail` values.
