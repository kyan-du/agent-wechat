# @agent-wechat/wechat

## 0.14.5

### Patch Changes

- [#145](https://github.com/kyan-du/agent-wechat/pull/145) [`73a9d72`](https://github.com/kyan-du/agent-wechat/commit/73a9d72e903012a43978092df34a3b800fb3a696) Thanks [@vangie](https://github.com/vangie)! - Attach nested and quoted media in one path: 聊天记录 / 引用 / 引用转发 resolve local image, file, voice, and video (datatype 2/3/4/8 and type 34/43). Missing Rec files stay retryable `CHAT_HISTORY_NOT_MATERIALIZED` without dropping already-resolved items. Quoted images with a 32-char md5 no longer get `QUOTED_IMAGE_RESOURCE_UNAVAILABLE`. Inbound validation accepts Word `.docx` and converted MP3 voice; raw SILK is not mislabeled as MPEG. Nested payloads require a unique verified full-content hash; Rec prefix/index collisions, thumbnail hashes, and duplicate md5 paths fail closed. Unidentified quoted cards are not clicked. Chat-history polling covers the GUI materialize budget and keeps partial items.

- [#147](https://github.com/kyan-du/agent-wechat/pull/147) [`0887189`](https://github.com/kyan-du/agent-wechat/commit/08871896ad1690d5b0a0ac42ec791d0ddc526fb9) Thanks [@kyan-du](https://github.com/kyan-du)! - Nested 聊天记录 images: disambiguate Rec `Img/N` by hardlink `file_size`, derive XOR from bare `{n}_t` thumbs, scroll the detail list after opening the card, and rematerialize missing Rec files by left-thumb double-click into Photos (then Escape). Raise chat-history materialize GUI/poll budget to 25s so scroll + Photos clicks fit; keep poll window ≥ that budget. Partial nested `items` no longer forever-`CHAT_HISTORY_NOT_MATERIALIZED`.

## 0.14.4

### Patch Changes

- [#135](https://github.com/kyan-du/agent-wechat/pull/135) [`d4825c0`](https://github.com/kyan-du/agent-wechat/commit/d4825c08568d8b415a9e365415db734ba2471490) Thanks [@kyan-du](https://github.com/kyan-du)! - Do not treat WeChat merged-forward / 聊天记录 cards as failed media downloads. Chat history keeps its `[Chat History]` text instead of appending `MEDIA_UNSUPPORTED`. Nested local images (`datatype=2`) and files (`datatype=8`) inside the record are decrypted when a `.dat`/file is on disk and attached as multiple inbound `MediaPaths`. CDN-only nested items without a local file are skipped. Voice/video nested items are not attached. File attachments (appmsg subtype 6) still poll.

- [#142](https://github.com/kyan-du/agent-wechat/pull/142) [`63ffe24`](https://github.com/kyan-du/agent-wechat/commit/63ffe2467c57d1141a6153ab0775a7cdf23f2e74) Thanks [@kyan-du](https://github.com/kyan-du)! - Materialize nested 聊天记录 images via AT-SPI: open chat, focus Messages, Page_Up/Down to the Chat History card, double-click ~12% from the left edge; return retryable `CHAT_HISTORY_NOT_MATERIALIZED` until Rec files appear.

- [#137](https://github.com/kyan-du/agent-wechat/pull/137) [`9cdf654`](https://github.com/kyan-du/agent-wechat/commit/9cdf65424927633bd96bdbc2051a536e9c3a948c) Thanks [@kyan-du](https://github.com/kyan-du)! - Sync OpenClaw allowlist interest to agent-server (`PUT/GET /api/interest`) and filter `listChats?interestOnly=true` so denied DMs stay out of the monitor poll without clearing WeChat badges. Only enable `interestOnly` after a successful server sync; re-GET each tick so an agent-server restart (in-memory wipe) triggers re-PUT.

- Back off sticky uncleared WeChat unreads with exponential retry delay and tip acknowledgements, avoiding repeated processing while the message tip and unread count are unchanged. Keep allowlist-denied badges unread, only open chats with allowed inbound messages, and log actionable unreads rather than every sticky badge (#136).

## 0.14.3

## 0.14.2

### Patch Changes

- [#127](https://github.com/kyan-du/agent-wechat/pull/127) [`9ddcff7`](https://github.com/kyan-du/agent-wechat/commit/9ddcff7a8ce2b5df81281a953d45cb972b211d4e) Thanks [@kyan-du](https://github.com/kyan-du)! - Trigger a bounded chat reopen for inbound WeChat file attachments (type=49 / `FILE_NOT_DOWNLOADED`) so group Word/PDF can materialize the same way type=3 images already do.

- [#129](https://github.com/kyan-du/agent-wechat/pull/129) [`1b71680`](https://github.com/kyan-du/agent-wechat/commit/1b7168015bc2ecf6729d7094d79fee38e6530c21) Thanks [@kyan-du](https://github.com/kyan-du)! - Click a uniquely identified inbound file bubble in the Linux WeChat GUI so group Word/PDF materialize under `msg/file/`. Plugin fire-and-forget `downloadFile` no longer aborts the overlay click from the short media poll window.

## 0.14.1

### Patch Changes

- Trigger inbound Weixin image download/reopen so type=3 images can materialize, with a short openChat timeout so poll stays bounded (#117).

- [#121](https://github.com/kyan-du/agent-wechat/pull/121) [`22f35f5`](https://github.com/kyan-du/agent-wechat/commit/22f35f5ab6aa41e593e09469e9644ccf27b3fc38) Thanks [@kyan-du](https://github.com/kyan-du)! - Keep newsapp feed delivery, skip other WeChat system chats in the unread monitor, and back off when unreadCount is set but listMessages returns nothing so empty fetches cannot spin the poll loop.

## 0.14.0

### Minor Changes

- [#78](https://github.com/kyan-du/agent-wechat/pull/78) [`27fcc5c`](https://github.com/kyan-du/agent-wechat/commit/27fcc5c0b1d4f8b7b13e2f4249a77fc9699865be) Thanks [@violet-hastings](https://github.com/violet-hastings)! - Add a privacy-minimized, read-only, paginated group member API, shared client method, CLI command, and explicit OpenClaw tool.

- [`54457a8`](https://github.com/kyan-du/agent-wechat/commit/54457a87944755716d0ad98422ead9e1f4cce350) - Deliver Tencent News (newsapp) feed previews as inbound text, with a hot-loop exit after skipped unread chats.

### Patch Changes

- [`54457a8`](https://github.com/kyan-du/agent-wechat/commit/54457a87944755716d0ad98422ead9e1f4cce350) - Import OpenClaw 2026.8.2 plugin-sdk subpaths and add a typecheck shim for channel-outbound.

- [#77](https://github.com/kyan-du/agent-wechat/pull/77) [`dabab58`](https://github.com/kyan-du/agent-wechat/commit/dabab580f29cdfa2109e64b9664f81951cefb934) Thanks [@audrey-blake](https://github.com/audrey-blake)! - Validate supported inbound PDF payloads while rejecting unverified file formats, preserve safe Unicode filenames, expose stable media diagnostics and image provenance, and report quoted-image resource limitations without dropping message text.

## 0.13.3

### Patch Changes

- Harden npm production release automation for registry retries and tag creation.

## 0.13.2

### Patch Changes

- Retry npm registry visibility checks during production release verification.

## 0.13.1

## 0.13.0

### Minor Changes

- [#71](https://github.com/kyan-du/agent-wechat/pull/71) [`8b272ca`](https://github.com/kyan-du/agent-wechat/commit/8b272ca02095fff28661844d7c0c1ebb259cb3bd) Thanks [@vangie](https://github.com/vangie)! - Rename the OpenClaw channel/plugin id from `wechat` to `agent-wechat`.

  OpenClaw 2026.7+ resolves outbound and cron channel names through the official catalog first. Catalog aliases `wechat` / `weixin` / `微信` map to `@tencent-weixin/openclaw-weixin`, so `openclaw channels login --channel wechat` and cron `delivery.channel=wechat` never reached this plugin.

  This plugin now registers as `agent-wechat` with no catalog-colliding aliases. `resolveWeChatAccount` still reads `channels.wechat` as a one-release fallback.

  After upgrading, reconfigure OpenClaw:

  - `plugins.entries.agent-wechat.enabled=true` (remove `plugins.entries.wechat` / leftover `openclaw-weixin`)
  - move `channels.wechat` → `channels.agent-wechat`
  - set cron `delivery.channel=agent-wechat`
  - `openclaw channels login --channel agent-wechat`
  - restart the gateway

## 0.12.0

### Minor Changes

- [#3](https://github.com/kyan-du/agent-wechat/pull/3) [`8b28b10`](https://github.com/kyan-du/agent-wechat/commit/8b28b10d5aa32e017b0c030333deca1efc14c0f1) Thanks [@kyan-du](https://github.com/kyan-du)! - Update for openclaw 2026.5+ compatibility:

  - Add `channelConfigs` metadata to `openclaw.plugin.json` so the gateway can validate config and load setup surfaces before the plugin runtime imports (silences the "channel plugin manifest declares wechat without channelConfigs metadata" warning).
  - Replace deprecated `runtime.config.loadConfig()` calls with `runtime.config.current()`.
  - Add a `message` adapter via `createChannelMessageAdapterFromOutbound` from `openclaw/plugin-sdk/channel-message`. The legacy `outbound` adapter is kept for older openclaw versions.
  - Bump the `openclaw` peer dependency floor to `^2026.5.12`.

  The deprecated `outbound` adapter and `dispatchReplyWithBufferedBlockDispatcher` ingest flow continue to work via openclaw's compat shims; a follow-up release will migrate the monitor's dispatch path to `core.channel.turn.runPrepared(...)`.

- [#8](https://github.com/kyan-du/agent-wechat/pull/8) [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095) Thanks [@vangie](https://github.com/vangie)! - Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

  - Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
  - Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
  - Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
  - Reconnect catch-up stays `read-only` unless `catchUpMode` is exactly `latest`. Auto-replies are capped at `catchUpChatBudget` chats (default 5), one per poll; leftovers stay held until the budget is raised or a human handles them
  - Security popups pause outbound; resume via POST /api/status/outbound/resume

## 0.12.0-next.0

### Minor Changes

- [#3](https://github.com/kyan-du/agent-wechat/pull/3) [`8b28b10`](https://github.com/kyan-du/agent-wechat/commit/8b28b10d5aa32e017b0c030333deca1efc14c0f1) Thanks [@kyan-du](https://github.com/kyan-du)! - Update for openclaw 2026.5+ compatibility:

  - Add `channelConfigs` metadata to `openclaw.plugin.json` so the gateway can validate config and load setup surfaces before the plugin runtime imports (silences the "channel plugin manifest declares wechat without channelConfigs metadata" warning).
  - Replace deprecated `runtime.config.loadConfig()` calls with `runtime.config.current()`.
  - Add a `message` adapter via `createChannelMessageAdapterFromOutbound` from `openclaw/plugin-sdk/channel-message`. The legacy `outbound` adapter is kept for older openclaw versions.
  - Bump the `openclaw` peer dependency floor to `^2026.5.12`.

  The deprecated `outbound` adapter and `dispatchReplyWithBufferedBlockDispatcher` ingest flow continue to work via openclaw's compat shims; a follow-up release will migrate the monitor's dispatch path to `core.channel.turn.runPrepared(...)`.

- [#8](https://github.com/kyan-du/agent-wechat/pull/8) [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095) Thanks [@vangie](https://github.com/vangie)! - Experimental fingerprint and send-pacing changes. Not a guarantee of account safety.

  - Per-volume machine-id; hostname/MAC generated before create (`wx up` or `scripts/device-identity.sh`) and passed into Docker. Compose fails closed if they are unset.
  - Outbound queue (from #4) plus chat cooldown, hourly/daily budgets, quiet hours, and inbound-length reading delay
  - Same-chat identity prefers live a11y header + local DB; Frida verify-only is fallback when that is ambiguous
  - Reconnect catch-up stays `read-only` unless `catchUpMode` is exactly `latest`. Auto-replies are capped at `catchUpChatBudget` chats (default 5), one per poll; leftovers stay held until the budget is raised or a human handles them
  - Security popups pause outbound; resume via POST /api/status/outbound/resume

## 0.11.15

### Patch Changes

- [#150](https://github.com/thisnick/agent-wechat/pull/150) [`80621fe`](https://github.com/thisnick/agent-wechat/commit/80621fec95a51b815785f92fa28403092caa0abd) Thanks [@thisnick](https://github.com/thisnick)! - fix(ci): pin npm to 11.12.1 for OIDC trusted publishing in release workflow

## 0.11.14

### Patch Changes

- [#148](https://github.com/thisnick/agent-wechat/pull/148) [`52056d9`](https://github.com/thisnick/agent-wechat/commit/52056d9b91243adcd890bf351af4a4a0e6c27604) Thanks [@thisnick](https://github.com/thisnick)! - Remove dead onboarding adapter that was deprecated in v0.11.10 but never deleted

## 0.11.13

## 0.11.12

### Patch Changes

- [#141](https://github.com/thisnick/agent-wechat/pull/141) [`5bd2938`](https://github.com/thisnick/agent-wechat/commit/5bd2938bda04def5d38b9e32146c3c5b26d45baf) Thanks [@thisnick](https://github.com/thisnick)! - Return "pending" instead of "unsupported" when voice data is not yet available in the database, so the extension retries instead of giving up.

## 0.11.11

### Patch Changes

- [#139](https://github.com/thisnick/agent-wechat/pull/139) [`c10d6ab`](https://github.com/thisnick/agent-wechat/commit/c10d6abc1dd96b1c4c6ef1b65968a62d6e0ace08) Thanks [@thisnick](https://github.com/thisnick)! - Add build profiles for new WeChat builds (3eda8254 aarch64, eba86b80 x86_64) with updated chat selection offsets and image XOR masks. Detach Frida hook after selectSession returns to restore function prologue.

## 0.11.10

### Patch Changes

- [#137](https://github.com/thisnick/agent-wechat/pull/137) [`9cb14d9`](https://github.com/thisnick/agent-wechat/commit/9cb14d9d0c153045805011b480b1fad780b9865c) Thanks [@thisnick](https://github.com/thisnick)! - Update openclaw dependency and fix breaking changes from plugin SDK refactor. Imports moved to dedicated subpaths (`channel-targets`, `config-runtime`, `command-auth`, `account-id`, `channel-reply-pipeline`). Removed deprecated `onboarding` adapter.

## 0.11.9

## 0.11.8

## 0.11.7

## 0.11.6

## 0.11.5

## 0.11.4

## 0.11.3

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.2

## 0.10.1

## 0.10.0

## 0.9.5

## 0.9.4

### Patch Changes

- [#84](https://github.com/thisnick/agent-wechat/pull/84) [`f76123f`](https://github.com/thisnick/agent-wechat/commit/f76123f2dd49d9fe6e64bbed8107f3a476480dd5) Thanks [@thisnick](https://github.com/thisnick)! - Stop retrying media poll when server returns unsupported type, and add video (type 43) to media types

## 0.9.3

### Patch Changes

- [#82](https://github.com/thisnick/agent-wechat/pull/82) [`06df0ad`](https://github.com/thisnick/agent-wechat/commit/06df0ad6a1b93989f09a26bee438695fd15e2232) Thanks [@thisnick](https://github.com/thisnick)! - Remove WAL checkpoint background task

## 0.9.2

### Patch Changes

- [#80](https://github.com/thisnick/agent-wechat/pull/80) [`ed43536`](https://github.com/thisnick/agent-wechat/commit/ed43536f1feaa28e0c276627dc4fdfda22870e75) Thanks [@thisnick](https://github.com/thisnick)! - Fix window activation targeting wrong window (e.g. "What's New" popup instead of main WeChat window)

## 0.9.1

### Patch Changes

- [#78](https://github.com/thisnick/agent-wechat/pull/78) [`5540a7f`](https://github.com/thisnick/agent-wechat/commit/5540a7f11283b5491d4f07e931fda13b7120be69) Thanks [@thisnick](https://github.com/thisnick)! - Update openclaw dependency to >=2026.3.2 and adapt readAllowFromStore call to new object-parameter signature

## 0.9.0

## 0.8.5

### Patch Changes

- [#72](https://github.com/thisnick/agent-wechat/pull/72) [`6be485a`](https://github.com/thisnick/agent-wechat/commit/6be485a7d7554d7e72e9e789ac011708eaa8f289) Thanks [@thisnick](https://github.com/thisnick)! - Fix @agent /command regex to support multi-word agent display names by using WeChat's hair space (U+2005) as the mention boundary instead of splitting on all whitespace

## 0.8.4

## 0.8.3

## 0.8.2

### Patch Changes

- [#66](https://github.com/thisnick/agent-wechat/pull/66) [`d730a10`](https://github.com/thisnick/agent-wechat/commit/d730a100a22a92d68bfa629a7f2c632befe3265c) Thanks [@thisnick](https://github.com/thisnick)! - Restore reliable group command handling for mention-prefixed commands such as `@agent /compact`.

  - Normalize WeChat command bodies so leading group mention tokens are stripped before command detection/authorization.
  - Use command-aware detection (`isControlCommandMessage`) in monitor gating paths.
  - Add a WeChat mention adapter so downstream command parsing also sees normalized command text.
  - Add tests covering mention-prefixed command normalization behavior.

## 0.8.1

### Patch Changes

- [#65](https://github.com/thisnick/agent-wechat/pull/65) [`e695cb5`](https://github.com/thisnick/agent-wechat/commit/e695cb5a1de0e747bd85037c29eb77ec484bcf1a) Thanks [@thisnick](https://github.com/thisnick)! - Harden WeChat inbound policy and command handling to align with OpenClaw channel security patterns.

  - Add centralized access-control logic for DM/group policy resolution and inbound decisions.
  - Normalize WeChat IDs/allowlists (including wildcard support) before authorization checks.
  - Compute and pass `CommandAuthorized` in inbound context and block unauthorized group control commands.
  - Apply mention gating with authorized command bypass behavior and fix segment-level mention handling.
  - Disable NO_REPLY command-window batching by isolating command-bearing messages into per-message dispatch.
  - Add group override support (`enabled`, `groupPolicy`, `allowFrom`) and align onboarding/docs semantics for `groupAllowFrom`.
  - Add unit tests for policy resolution, authorization, and mention/command gating behavior.

## 0.8.0

## 0.7.10

### Patch Changes

- [#56](https://github.com/thisnick/agent-wechat/pull/56) [`59e6061`](https://github.com/thisnick/agent-wechat/commit/59e6061e6836b683e734e80b7f9df82aca40d050) Thanks [@thisnick](https://github.com/thisnick)! - Revert READ_ONLY + busy_timeout DB reads back to immutable=1 with WAL checkpoint task. The READ_ONLY approach from #53 did not work as expected.

## 0.7.9

### Patch Changes

- [#53](https://github.com/thisnick/agent-wechat/pull/53) [`68a9a4e`](https://github.com/thisnick/agent-wechat/commit/68a9a4ea3871a7a4ee951ed29841fb5431924949) Thanks [@thisnick](https://github.com/thisnick)! - Fix stale WeChat DB reads by replacing immutable=1 with READ_ONLY + busy_timeout. WeChat DBs likely use DELETE journal mode where immutable=1 skips change-detection entirely. Also adds journal_mode logging to confirm the actual mode.

## 0.7.8

### Patch Changes

- [#51](https://github.com/thisnick/agent-wechat/pull/51) [`2d035a7`](https://github.com/thisnick/agent-wechat/commit/2d035a78544cee2b949a64cadaeee32ab0314400) Thanks [@thisnick](https://github.com/thisnick)! - Add periodic WAL checkpoint for fresh WeChat DB reads. A background task runs PASSIVE checkpoint every 3s, flushing WAL to the main DB file so immutable=1 reads see up-to-date data.

## 0.7.7

### Patch Changes

- [`f637558`](https://github.com/thisnick/agent-wechat/commit/f6375585be4939f6ed43c610910d585bee35a287) Thanks [@thisnick](https://github.com/thisnick)! - Rewrite README with improved setup flow, prerequisites, and limitations

## 0.7.6

### Patch Changes

- [#44](https://github.com/thisnick/agent-wechat/pull/44) [`feb823c`](https://github.com/thisnick/agent-wechat/commit/feb823c5add5bd5f08e451fa6dbfdff37b2d6e40) Thanks [@thisnick](https://github.com/thisnick)! - Re-extract DB credentials when new message databases appear after login

## 0.7.5

### Patch Changes

- [`109bb0f`](https://github.com/thisnick/agent-wechat/commit/109bb0f088c0291bea4adcdfd7f25347dc52d59b) Thanks [@thisnick](https://github.com/thisnick)! - Document hosted instance support and token configuration in README

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

### Minor Changes

- [`9b1e871`](https://github.com/thisnick/agent-wechat/commit/9b1e871d8666216fa295c44400e1108eeb34a4ef) Thanks [@thisnick](https://github.com/thisnick)! - Buffer non-mentioned group messages and inject as history context when a mention arrives. Only the latest media attachment is preserved to avoid flooding the agent.

## 0.4.1

### Patch Changes

- [#29](https://github.com/thisnick/agent-wechat/pull/29) [`5e53df8`](https://github.com/thisnick/agent-wechat/commit/5e53df8eadd9b37d7812b00bc9c96303dffb52a0) Thanks [@thisnick](https://github.com/thisnick)! - Remove unreliable shell-out for heartbeat wake; auth notifications use passive system events instead.

## 0.4.0

### Minor Changes

- [#27](https://github.com/thisnick/agent-wechat/pull/27) [`8b07604`](https://github.com/thisnick/agent-wechat/commit/8b076041933b892d3361398646ddf1deb2268fc5) Thanks [@thisnick](https://github.com/thisnick)! - Proactive auth notifications: agent is notified immediately when WeChat auth is lost and can attempt re-login using cached credentials. Aligned all types with latest openclaw plugin SDK.

## 0.3.1

### Patch Changes

- [`0b45fba`](https://github.com/thisnick/agent-wechat/commit/0b45fba481778f5f7791b9787621270e1a9d1a23) Thanks [@thisnick](https://github.com/thisnick)! - Fix group message mention gating not working

  The monitor was not checking `msg.isMentioned` before dispatching group messages, so all group messages were processed regardless of `requireMention` config. Now:

  - Skips group messages that require mention but weren't mentioned
  - Sets `WasMentioned` in the inbound context for framework-level mention awareness

## 0.3.0

### Minor Changes

- [`3dba4d7`](https://github.com/thisnick/agent-wechat/commit/3dba4d7c3381fc73bd5e0732bdaf6f89341b480b) Thanks [@thisnick](https://github.com/thisnick)! - Add WeChat crash recovery and auth status enum

  - Auto-restart WeChat in entrypoint with crash-loop backoff (3s delay, 30s backoff after 5 rapid restarts)
  - Replace `isLoggedIn: boolean` with `status: "logged_in" | "logged_out" | "app_not_running" | "unknown"` in auth endpoint
  - Detect WeChat process not running via `find_wechat_pid()` check before a11y observation
  - Notify agent on auth state transitions (session lost, server unreachable, first-poll not authenticated)
  - Add `app_not_running` diagnostic in openclaw extension status checks

## 0.2.4

### Patch Changes

- [`09aa334`](https://github.com/thisnick/agent-wechat/commit/09aa334d9fef0a67ab092f5f68e10540bd8af9bf) Thanks [@thisnick](https://github.com/thisnick)! - Fix image media retrieval for newly received images by using message_resource.db as the primary file lookup instead of hardlink.db, which has an indexing delay.

## 0.2.3

### Patch Changes

- [`91d6750`](https://github.com/thisnick/agent-wechat/commit/91d67504ffc3965c046ea28e13e2d9d3d5fedaf3) Thanks [@thisnick](https://github.com/thisnick)! - - Use versioned Docker image tags matching CLI version, with fallback to latest
  - Inject version from package.json at build time
  - Fix release workflow Docker tag parsing for scoped packages
  - Increase media poll retries from 5 to 15
  - Add setup docs to both package READMEs

## 0.2.2

### Patch Changes

- [`32e6d04`](https://github.com/thisnick/agent-wechat/commit/32e6d04eb4aca78f6143feb3b0b4c86d08a39f44) Thanks [@thisnick](https://github.com/thisnick)! - Use versioned Docker image tags matching CLI version, fix release workflow version parsing

## 0.2.1

### Patch Changes

- [`ff4e228`](https://github.com/thisnick/agent-wechat/commit/ff4e2288b0f89d3f4ea8e78778a6f31f8d86352d) Thanks [@thisnick](https://github.com/thisnick)! - Auto-pull Docker image in `wx up` when not found locally, add README docs for both packages

## 0.2.0

### Minor Changes

- [`9f1911d`](https://github.com/thisnick/agent-wechat/commit/9f1911dfc80194330dc9e6c352b2c181515ce300) Thanks [@thisnick](https://github.com/thisnick)! - Initial public release

  - CLI (`wx`) for managing agent-wechat containers
  - OpenClaw WeChat channel extension with login, directory, and heartbeat adapters
  - Multi-arch Docker image (amd64/arm64)
