---
"@kyan-du/agent-wechat-agent-server": patch
"@kyan-du/agent-wechat-cli": patch
---

Fix composer discovery on WeChat 4.1.x where the editable input and Send button are cousins in the a11y tree (not siblings), which previously caused COMPOSER_UNAVAILABLE / localized_composer_not_found after a successful chat open.
