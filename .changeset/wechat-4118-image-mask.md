---
"@kyan-du/agent-wechat-agent-server": patch
---

Add the image_xor_mask for WeChat Linux v4.1.1.8 aarch64 (BuildID 9a3558be) so
inbound type=3 images decrypt instead of failing with IMAGE_RESOURCE_UNAVAILABLE
(#119). extract-keys.py now fails loudly on an unknown BuildID rather than
silently falling back to another build's mask, and a new WeChat BuildID must
update BUILD_PROFILES in both chat-select.py and extract-keys.py.
