# @agent-wechat/agent-server

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
