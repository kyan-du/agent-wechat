---
"@kyan-du/agent-wechat-openclaw": minor
---

Decide WeChat access with OpenClaw's channel ingress policy instead of a local copy of it (ported from upstream thisnick/agent-wechat e743310). DM and group sender gates, per-group overrides, control-command authorization and @mention gating now come from OpenClaw core, so `accessGroup:<name>` entries work in `allowFrom`, `groupAllowFrom` and per-group `allowFrom`. Existing configs keep their behavior, with two exceptions:

- The pairing store no longer admits group senders or authorizes commands. WeChat has no pairing flow, so the store is normally empty.
- `dmPolicy: "open"` without `"*"` in `allowFrom` still admits everyone, but now logs a reminder to add `"*"`.

The plugin is now built and type-checked against the OpenClaw 2026.10 SDK directly (the `channel-outbound` typecheck shim is gone), so CI and release jobs run on Node 24. The plugin needs an OpenClaw host of 2026.10 or newer.
