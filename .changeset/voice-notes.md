---
"@kyan-du/agent-wechat-openclaw": minor
"@kyan-du/agent-wechat-cli": minor
"@kyan-du/agent-wechat-shared": minor
---

Add queued voice-note sending (port of upstream b288698): 50-second audio splitting, job status and cancellation, `wx send --voice` / `wx voice status|cancel`, and OpenClaw `audioAsVoice` delivery. Requires a rebuilt container image (PulseAudio + voice worker); a missing audio device only disables voice sending.
