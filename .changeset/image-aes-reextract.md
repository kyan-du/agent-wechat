---
"@kyan-du/agent-wechat-agent-server": patch
---

Re-run WeChat key extraction when stored DB keys exist but `_image_aes` is missing after an image-key upgrade (#119). Login no longer skips extract just because older DB keys are already in the agent DB.
