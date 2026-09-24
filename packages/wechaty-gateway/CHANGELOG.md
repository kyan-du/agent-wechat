# @agent-wechat/wechaty-gateway

## 0.15.1

### Minor Changes

- [#149](https://github.com/kyan-du/agent-wechat/pull/149) [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884) Thanks [@vangie](https://github.com/vangie)! - Upgrade the runtime image to WeChat Linux v4.1.13.23. Capture the login passphrase automatically before QR/saved-account login, derive SQLCipher compatibility-4 keys without a hand-placed passphrase file, and pin both architectures to verified Wayback `if_` packages.

### Patch Changes

- [#149](https://github.com/kyan-du/agent-wechat/pull/149) [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884) Thanks [@vangie](https://github.com/vangie)! - Fix WeChat Linux 4.1.13.23 chat open on ARM64: activate the main window before clicks, select by visible UI list order (not Frida vector index), and reject unverified openChat HTTP 200 responses in the OpenClaw plugin.

- [#149](https://github.com/kyan-du/agent-wechat/pull/149) [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884) Thanks [@vangie](https://github.com/vangie)! - Identify the live WeChat main process from `/proc` identity instead of `pgrep -f` path substrings, so crashpad helpers are not selected during login passphrase capture. When `message_resource.db` exists on disk, require a working stored key so a stale credential re-extracts; a missing file does not retry.

- [#149](https://github.com/kyan-du/agent-wechat/pull/149) [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884) Thanks [@vangie](https://github.com/vangie)! - Start Xvfb and x11vnc as the WeChat user so Linux 4.1.13+ can render a scannable login QR without extra container capabilities.

- Updated dependencies [[`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884), [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884), [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884), [`d9bfcfb`](https://github.com/kyan-du/agent-wechat/commit/d9bfcfb0551acb37d7f9ecdc95f1dd17b4af1884)]:
  - @kyan-du/agent-wechat-wechaty-puppet@0.15.1

## 0.14.6

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [[`63ffe24`](https://github.com/kyan-du/agent-wechat/commit/63ffe2467c57d1141a6153ab0775a7cdf23f2e74)]:
  - @kyan-du/agent-wechat-shared@0.1.3
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.3

## 0.14.2

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [[`dabab58`](https://github.com/kyan-du/agent-wechat/commit/dabab580f29cdfa2109e64b9664f81951cefb934)]:
  - @kyan-du/agent-wechat-shared@0.1.2
  - @kyan-du/agent-wechat-wechaty-puppet@0.14.0

## 0.13.3

### Patch Changes

- Harden npm production release automation for registry retries and tag creation.

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.13.3

## 0.13.2

### Patch Changes

- Retry npm registry visibility checks during production release verification.

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies []:
  - @kyan-du/agent-wechat-wechaty-puppet@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [[`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037), [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095)]:
  - @kyan-du/agent-wechat-shared@0.1.1
  - @kyan-du/agent-wechat-wechaty-puppet@0.12.0

## 0.12.0-next.0

### Patch Changes

- Updated dependencies [[`4a494e9`](https://github.com/kyan-du/agent-wechat/commit/4a494e9a9417375424ceeeb7c4bc09e603ef5037), [`522415f`](https://github.com/kyan-du/agent-wechat/commit/522415fa1208919f7b4edf5ad785ca6fa11d0095)]:
  - @kyan-du/agent-wechat-shared@0.1.1-next.0
  - @kyan-du/agent-wechat-wechaty-puppet@0.12.0-next.0

## 0.11.15

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.15

## 0.11.14

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.14

## 0.11.13

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.13

## 0.11.12

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.12

## 0.11.11

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.11

## 0.11.10

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.10

## 0.11.9

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.9

## 0.11.8

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.8

## 0.11.7

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.7

## 0.11.6

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.6

## 0.11.5

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.5

## 0.11.4

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.4

## 0.11.3

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.3

## 0.11.2

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.11.0

## 0.10.2

### Patch Changes

- [#99](https://github.com/thisnick/agent-wechat/pull/99) [`7fc2fa1`](https://github.com/thisnick/agent-wechat/commit/7fc2fa192b50094cd5798843a9a47bd8f47274d3) Thanks [@thisnick](https://github.com/thisnick)! - Use WECHATY_PUPPET_SERVICE_IP for chatie.io registry to advertise correct public IP

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.10.2

## 0.10.1

### Patch Changes

- [#98](https://github.com/thisnick/agent-wechat/pull/98) [`6e84a15`](https://github.com/thisnick/agent-wechat/commit/6e84a1546cf2f69b36d7daf69a1d487a7fdc2da3) Thanks [@thisnick](https://github.com/thisnick)! - Register with chatie.io service discovery on startup so clients can resolve token to endpoint

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.10.0

## 0.9.5

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.9.5

## 0.9.4

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies []:
  - @agent-wechat/wechaty-puppet@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`30a2981`](https://github.com/thisnick/agent-wechat/commit/30a2981f9c728e09b686a37f5aca1687baa5a70d)]:
  - @agent-wechat/wechaty-puppet@0.9.0
