# @agent-wechat/agent-server

## 0.14.4

### Patch Changes

- [#138](https://github.com/kyan-du/agent-wechat/pull/138) [`c97f80a`](https://github.com/kyan-du/agent-wechat/commit/c97f80a7ef09921e7d43bf151fed3097c19c6d93) Thanks [@kyan-du](https://github.com/kyan-du)! - Parse WeChat merged-forward / 聊天记录 cards whose `<recorditem>` payload is wrapped in CDATA (`<![CDATA[<recordinfo>…</recordinfo>]]>`) instead of HTML-entity escaping. Image-only `datatype=2` items without `datatitle`/`datadesc` still become forwarded nodes. Existing entity-escaped recorditem fixtures stay valid. Nested image bytes still require a local image file, including the `Rec/*/Img` paths resolved by #141.

- [#135](https://github.com/kyan-du/agent-wechat/pull/135) [`d4825c0`](https://github.com/kyan-du/agent-wechat/commit/d4825c08568d8b415a9e365415db734ba2471490) Thanks [@kyan-du](https://github.com/kyan-du)! - Do not treat WeChat merged-forward / 聊天记录 cards as failed media downloads. Chat history keeps its `[Chat History]` text instead of appending `MEDIA_UNSUPPORTED`. Nested local images (`datatype=2`) and files (`datatype=8`) inside the record are decrypted when a `.dat`/file is on disk and attached as multiple inbound `MediaPaths`. CDN-only nested items without a local file are skipped. Voice/video nested items are not attached. File attachments (appmsg subtype 6) still poll.

- [#142](https://github.com/kyan-du/agent-wechat/pull/142) [`63ffe24`](https://github.com/kyan-du/agent-wechat/commit/63ffe2467c57d1141a6153ab0775a7cdf23f2e74) Thanks [@kyan-du](https://github.com/kyan-du)! - Materialize nested 聊天记录 images via AT-SPI: open chat, focus Messages, Page_Up/Down to the Chat History card, double-click ~12% from the left edge; return retryable `CHAT_HISTORY_NOT_MATERIALIZED` until Rec files appear.

- [#137](https://github.com/kyan-du/agent-wechat/pull/137) [`9cdf654`](https://github.com/kyan-du/agent-wechat/commit/9cdf65424927633bd96bdbc2051a536e9c3a948c) Thanks [@kyan-du](https://github.com/kyan-du)! - Sync OpenClaw allowlist interest to agent-server (`PUT/GET /api/interest`) and filter `listChats?interestOnly=true` so denied DMs stay out of the monitor poll without clearing WeChat badges. Only enable `interestOnly` after a successful server sync; re-GET each tick so an agent-server restart (in-memory wipe) triggers re-PUT.

- [#140](https://github.com/kyan-du/agent-wechat/pull/140) [`aa2a7c2`](https://github.com/kyan-du/agent-wechat/commit/aa2a7c2b0fe8e97dee06003c7f158d1f58b00840) Thanks [@kyan-du](https://github.com/kyan-du)! - Look up local nested chat-history images by md5 filename when the hardlink lookup misses (#140). The experimental HTTP CDN fallback from that change was removed in #141; CDN-only nested images are not downloaded.

- [#141](https://github.com/kyan-du/agent-wechat/pull/141) [`3fd9795`](https://github.com/kyan-du/agent-wechat/commit/3fd97956334fb91e6100c4943a366446992d5014) Thanks [@kyan-du](https://github.com/kyan-du)! - Resolve nested 聊天记录 images via `msg/attach/<chat>/<yyyy-mm>/Rec/*/Img/{file}` hardlink paths (bare `0`/`1`/`2` without `.dat`); remove the ineffective HTTP CDN nested-image fallback.

- [#139](https://github.com/kyan-du/agent-wechat/pull/139) [`d32f547`](https://github.com/kyan-du/agent-wechat/commit/d32f547abef2db080e1401bb4535f74814bc84f3) Thanks [@kyan-du](https://github.com/kyan-du)! - Parse WeChat quote/reply (`<refermsg>`) of merged-forward / 聊天记录 cards: unwrap the entity-escaped (and CDATA) payload in `refermsg/content`, populate `forwarded.nodes`, and route media through the same nested dataitem path as a direct forward. Plain quoted images still report `QUOTED_IMAGE_RESOURCE_UNAVAILABLE`. Nested image bytes still require a local image file, including the `Rec/*/Img` paths resolved by #141.

  This adds quoted-card parsing and server-side media routing, not verified automatic attachment of nested images to quoted messages. The quoted-message end-to-end attachment path remains unresolved; nested voice/video are not supported.

## 0.14.3

### Patch Changes

- [#133](https://github.com/kyan-du/agent-wechat/pull/133) [`a4ba543`](https://github.com/kyan-du/agent-wechat/commit/a4ba5438a7a21915258469cebb1896beb54aebe4) Thanks [@kyan-du](https://github.com/kyan-du)! - Report logged-in idle chat list as `chat_idle` instead of `composer_unavailable` / `COMPOSER_UNAVAILABLE`, so `wx status` and `/api/status` can tell "no conversation selected" apart from a missing composer after open/focus.

## 0.14.2

### Patch Changes

- [#129](https://github.com/kyan-du/agent-wechat/pull/129) [`1b71680`](https://github.com/kyan-du/agent-wechat/commit/1b7168015bc2ecf6729d7094d79fee38e6530c21) Thanks [@kyan-du](https://github.com/kyan-du)! - Click a uniquely identified inbound file bubble in the Linux WeChat GUI so group Word/PDF materialize under `msg/file/`. Plugin fire-and-forget `downloadFile` no longer aborts the overlay click from the short media poll window.

## 0.14.1

### Patch Changes

- [#121](https://github.com/kyan-du/agent-wechat/pull/121) [`22f35f5`](https://github.com/kyan-du/agent-wechat/commit/22f35f5ab6aa41e593e09469e9644ccf27b3fc38) Thanks [@kyan-du](https://github.com/kyan-du)! - Logged-in health monitor re-extracts missing `_image_aes` on the Chat/ChatOpen hot path without a full login.

- [#121](https://github.com/kyan-du/agent-wechat/pull/121) [`22f35f5`](https://github.com/kyan-du/agent-wechat/commit/22f35f5ab6aa41e593e09469e9644ccf27b3fc38) Thanks [@kyan-du](https://github.com/kyan-du)! - Re-run WeChat key extraction when stored DB keys exist but `_image_aes` is missing after an image-key upgrade (#119). Login no longer skips extract just because older DB keys are already in the agent DB.

- Trigger inbound Weixin image download/reopen so type=3 images can materialize, with a short openChat timeout so poll stays bounded (#117).

- [#121](https://github.com/kyan-du/agent-wechat/pull/121) [`22f35f5`](https://github.com/kyan-du/agent-wechat/commit/22f35f5ab6aa41e593e09469e9644ccf27b3fc38) Thanks [@kyan-du](https://github.com/kyan-du)! - Disable outbound quiet hours by default (`AGENT_WECHAT_QUIET_START_MIN`/`END_MIN` = 0/0). Operators can still set a window via env, TOML, or `--outbound-quiet-start`/`--outbound-quiet-end`.

- [#120](https://github.com/kyan-du/agent-wechat/pull/120) [`ad49585`](https://github.com/kyan-du/agent-wechat/commit/ad49585cb16d8b80501d1da8622bc6f31b805091) Thanks [@vangie](https://github.com/vangie)! - Add the image_xor_mask for WeChat Linux v4.1.1.8 aarch64 (BuildID 9a3558be) so
  inbound type=3 images decrypt instead of failing with IMAGE_RESOURCE_UNAVAILABLE
  (#119). extract-keys.py now fails loudly on an unknown BuildID rather than
  silently falling back to another build's mask, and a new WeChat BuildID must
  update BUILD_PROFILES in both chat-select.py and extract-keys.py.

## 0.14.0

### Patch Changes

- [#76](https://github.com/kyan-du/agent-wechat/pull/76) [`eeee686`](https://github.com/kyan-du/agent-wechat/commit/eeee68659315699f2fdad615509aad059c772df1) Thanks [@audrey-blake](https://github.com/audrey-blake)! - Recognize an open chat from the live main-window composer when its selected sidebar row is outside the accessibility viewport, while preserving independent target confirmation and bounded fail-closed send diagnostics.

- [#100](https://github.com/kyan-du/agent-wechat/pull/100) [`07ecc4a`](https://github.com/kyan-du/agent-wechat/commit/07ecc4a4d9771c78c2b1cf718586993858cf03a1) Thanks [@kyan-du](https://github.com/kyan-du)! - Treat the WeChat update/about overlay as a blocking popup so auth status reports `popup_blocked` instead of `composer_unavailable`, and keep the CLI's volume cleanup limited to practical local-Docker checks.

- [#77](https://github.com/kyan-du/agent-wechat/pull/77) [`dabab58`](https://github.com/kyan-du/agent-wechat/commit/dabab580f29cdfa2109e64b9664f81951cefb934) Thanks [@audrey-blake](https://github.com/audrey-blake)! - Validate supported inbound PDF payloads while rejecting unverified file formats, preserve safe Unicode filenames, expose stable media diagnostics and image provenance, and report quoted-image resource limitations without dropping message text.

## 0.13.3

### Patch Changes

- Harden npm production release automation for registry retries and tag creation.

## 0.13.2

### Patch Changes

- Retry npm registry visibility checks during production release verification.

## 0.13.1

## 0.13.0

## 0.12.0

### Patch Changes

- [#4](https://github.com/kyan-du/agent-wechat/pull/4) [`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037) Thanks [@kyan-du](https://github.com/kyan-du)! - Add a bounded server-side outbound send queue for `/api/messages/send` with conservative spacing, jitter for burst smoothing, queued-task expiry, short-lived `idempotencyKey` replay, explicit queue-full responses, and an emergency read-only kill switch.

- [#3](https://github.com/kyan-du/agent-wechat/pull/3) [`8b28b10`](https://github.com/kyan-du/agent-wechat/commit/8b28b10d5aa32e017b0c030333deca1efc14c0f1) Thanks [@kyan-du](https://github.com/kyan-du)! - feat: parse merged-forward (chat history) messages (type 49, subtype 19)

  Previously, "Combine and Forward" messages only showed the title (e.g.
  "Chat History of Group X"). Now the agent extracts the full
  `<recorditem>` XML and renders each forwarded message as
  `sender: content`, giving agents visibility into the actual conversation.

  Closes #126

## 0.12.0-next.0

### Patch Changes

- [#4](https://github.com/kyan-du/agent-wechat/pull/4) [`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037) Thanks [@kyan-du](https://github.com/kyan-du)! - Add a bounded server-side outbound send queue for `/api/messages/send` with conservative spacing, jitter for burst smoothing, queued-task expiry, short-lived `idempotencyKey` replay, explicit queue-full responses, and an emergency read-only kill switch.

- [#3](https://github.com/kyan-du/agent-wechat/pull/3) [`8b28b10`](https://github.com/kyan-du/agent-wechat/commit/8b28b10d5aa32e017b0c030333deca1efc14c0f1) Thanks [@kyan-du](https://github.com/kyan-du)! - feat: parse merged-forward (chat history) messages (type 49, subtype 19)

  Previously, "Combine and Forward" messages only showed the title (e.g.
  "Chat History of Group X"). Now the agent extracts the full
  `<recorditem>` XML and renders each forwarded message as
  `sender: content`, giving agents visibility into the actual conversation.

  Closes #126

## 0.11.15

## 0.11.14

## 0.11.13

### Patch Changes

- [#143](https://github.com/thisnick/agent-wechat/pull/143) [`ba19907`](https://github.com/thisnick/agent-wechat/commit/ba19907d72d2e3a347923eb96a5c69ed9c5dc643) Thanks [@kyan-du](https://github.com/kyan-du)! - fix: handle non-ASCII filenames in file send

  - Use portable `iconv` check instead of GNU-only `grep -P` for non-ASCII path detection in paste-file
  - Sanitize filenames to ASCII-safe temp paths so WeChat (Qt/POSIX locale) can open them
  - Return proper error responses on base64 decode or file write failures instead of silent success

## 0.11.12

### Patch Changes

- [#141](https://github.com/thisnick/agent-wechat/pull/141) [`5bd2938`](https://github.com/thisnick/agent-wechat/commit/5bd2938bda04def5d38b9e32146c3c5b26d45baf) Thanks [@thisnick](https://github.com/thisnick)! - Return "pending" instead of "unsupported" when voice data is not yet available in the database, so the extension retries instead of giving up.

## 0.11.11

## 0.11.10

## 0.11.9

### Patch Changes

- [#134](https://github.com/thisnick/agent-wechat/pull/134) [`2ceb514`](https://github.com/thisnick/agent-wechat/commit/2ceb51456bfb0cbc6fe96cba4aa3e2c25f653373) Thanks [@thisnick](https://github.com/thisnick)! - Keep token query param in VNC URL so the page works when accessed directly via bookmark or shared link

## 0.11.8

### Patch Changes

- [#132](https://github.com/thisnick/agent-wechat/pull/132) [`771a1c1`](https://github.com/thisnick/agent-wechat/commit/771a1c1540a6d1846a440a095121be876a7c7916) Thanks [@thisnick](https://github.com/thisnick)! - Fix VNC WebSocket auth: keep token embedded in the noVNC `path` query param so it is passed to the WebSocket connection, and remove it from the visible URL for security

## 0.11.7

### Patch Changes

- [#129](https://github.com/thisnick/agent-wechat/pull/129) [`22f132d`](https://github.com/thisnick/agent-wechat/commit/22f132d362c7362151ad670557de83d3d0ce2f29) Thanks [@thisnick](https://github.com/thisnick)! - Fix VNC redirect encoding by passing token as a separate query parameter instead of embedding it in the URL path

## 0.11.6

### Patch Changes

- [#124](https://github.com/thisnick/agent-wechat/pull/124) [`e608898`](https://github.com/thisnick/agent-wechat/commit/e60889870686f25e289aa58bd38fe35e410c36ee) Thanks [@thisnick](https://github.com/thisnick)! - Fix WeChat restart kill loop caused by wrong DBUS_SESSION_BUS_ADDRESS

  The health monitor's spawn_wechat was passing the DB-stored D-Bus address
  when restarting WeChat, which could differ from the D-Bus session that
  AT-SPI is connected to. This caused restarted WeChat instances to have an
  empty a11y tree, triggering repeated unresponsive detection and kill cycles.
  Now inherits the correct D-Bus address from the agent-server process environment.
