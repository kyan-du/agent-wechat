# @kyan-du/agent-wechat-cli

Single-instance CLI for managing agent-wechat and interacting with WeChat.

> **Release boundary: P1-B remains unavailable until an owner/legal-approved prerelease publishes and independently verifies npm and GHCR artifacts.** All commands in this document use the repository-only `pnpm cli` form; do not substitute bare `wx` before that gate is cleared.

## Install

The fork package is not published yet. From a repository checkout run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm build:image
pnpm cli start
pnpm cli auth login
```

After publication is independently verified, the release runbook will provide the exact npm installation command and bare `wx` invocation. Until then, do not attempt a global install.

Uninstall with npm after a real install exists. The CLI intentionally has no uninstall subcommand. To erase the trusted default instance first, use the repository form `pnpm cli stop --purge` and confirm the displayed resource list, then use the package manager that installed it.

## Command surface

```text
pnpm cli start [--image <fork-semver-commit-or-digest>] [--pull | --offline] [--proxy <url>]
pnpm cli stop [--purge] [--yes]
pnpm cli restart
pnpm cli status
pnpm cli doctor
pnpm cli logs

pnpm cli auth login [--timeout <seconds>] [--new]
pnpm cli auth logout
pnpm cli auth reset [--yes]
pnpm cli auth status

pnpm cli chats [--unread] [--limit <n>] [--cursor <cursor>]
pnpm cli chats show <chat-id>
pnpm cli chats mark-read <chat-id>
pnpm cli chats members <group-id> [--limit <n>] [--cursor <cursor>]
pnpm cli contacts [--limit <n>] [--cursor <cursor>]
pnpm cli contacts find <name>
pnpm cli messages <chat-id> [--limit <n>] [--cursor <cursor>]
pnpm cli send <chat-id> (--text <message> | --image <path> | --file <path>)
  [--idempotency-key <key>] [--confirm-similar]

pnpm cli upgrade [--check | --cli | --image <fork-semver-commit-or-digest>]
```

The first fork prerelease is deliberately single-instance. Removed `up`, `down`, `update`, and `session` commands exit nonzero with migration guidance; they never execute old behavior and do not migrate historical state.

### Lifecycle guarantees

- `start` runs a local architecture build during source development, or an explicit fork semver, seven-character commit tag, or digest. Floating `latest`, foreign repositories, and malformed references are rejected.
- A published tag is pulled and resolved to its immutable fork repository digest. The inventory records the exact container ID, digest, port, volumes, token path, and identity directory.
- Offline `--offline` succeeds only when the selected compatible image already exists locally.
- Existing containers are reused only when their ID, ownership label, volumes, identity, port, and requested image match the trusted inventory.
- `status` and `doctor` are read-only. They never pull, start, migrate, repair, or expose token/proxy contents.
- `stop` removes only the trusted container and keeps data. `stop --purge` deletes only resources named by the validated default-instance inventory; `--yes` skips confirmation but never validation.

### Authentication and reads

`auth logout` verifies the WeChat UI logout and preserves instance data. `auth reset` stops the session, transactionally clears server-side authentication state, deletes the WeChat home volume, and clears both the host and `/data/device-identity` copies before requiring a fresh `start`/login. It is narrower than full purge: agent DB, token, and the default instance inventory remain.

`chats`, `contacts`, `messages`, and `chats members` are read-only. Their opaque, versioned cursor uses stable keyset ordering; adding new rows does not shift later pages. `chats members` requires a stable `@chatroom` id and returns only member id, display name, optional group alias, and optional nickname—never avatars. `chats --unread` means only conversation-level `unreadCount > 0`. Message reads never open the UI or change unread state. `mark-read` is a separate UI operation and succeeds only when the target and before/after unread state are verified.

### Sending

The first prerelease accepts only a stable chat ID. It never resolves a display name or guesses among contacts. Exactly one payload flag is required. Uploads must be regular, non-symlink files no larger than the server limit. `--idempotency-key` exposes durable retry/reconciliation behavior. Similar-content confirmation, `429` metadata, and `commitAttempted` uncertain outcomes remain distinct; an uncertain send is never automatically retried.

### Machine output

Global `--json` emits exactly one versioned JSON envelope on stdout. Diagnostics are written to stderr. Stable exit categories distinguish arguments (`2`), environment (`3`), service (`4`), authentication (`5`), target (`6`), confirmation (`7`), rate limit (`8`), uncertain send (`9`), cleanup (`10`), and rollback (`11`).

## Upgrade

- `wx upgrade --check` is read-only.
- `pnpm cli upgrade --cli` fails with `CLI_UPGRADE_UNAVAILABLE` until P1-B npm publication is independently verified; it never prints or executes a premature install command.
- `wx upgrade --image <reference>` accepts a fork semver tag, seven-character commit-verification tag, or digest; it resolves the selected image to an immutable digest, rebuilds the container with persistent volumes, verifies health, and rolls the container/image back on failure. Commit tags are verification artifacts, not formal releases.

The hidden `pnpm cli dev sync-server --binary <path> --sha256 <hex>` command is only for checked local development artifacts. It checksum-verifies the binary and restores the previous server if health validation fails.

## Release boundary

No npm package, GHCR image, tag, or GitHub Release is available until the separate validation, licensing, owner, and redistribution gates are satisfied. Repository instructions must continue to use `pnpm cli` until real publication is independently verified.
