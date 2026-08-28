---
"@kyan-du/agent-wechat-agent-server": patch
"@kyan-du/agent-wechat-cli": patch
---

Treat the WeChat update/about overlay as a blocking popup so auth status reports `popup_blocked` instead of `composer_unavailable`, and keep the CLI's volume cleanup limited to practical local-Docker checks.
