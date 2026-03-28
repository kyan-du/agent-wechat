---
"@agent-wechat/agent-server": patch
---

fix: handle non-ASCII filenames in file send

- Use portable `iconv` check instead of GNU-only `grep -P` for non-ASCII path detection in paste-file
- Sanitize filenames to ASCII-safe temp paths so WeChat (Qt/POSIX locale) can open them
- Return proper error responses on base64 decode or file write failures instead of silent success
