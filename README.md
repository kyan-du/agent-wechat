# agent-wechat

A programmable WeChat interface. Controls a WeChat client running in a Docker container — receive and send messages, see chat heads, and more via API, CLI, Wechaty puppet, or OpenClaw plugin.

> [!IMPORTANT]
> Fork npm packages, GHCR images, and hosted documentation are **not released yet**. P1-B must verify and publish them before those channels are usable. Until then, clone this repository and use the source/local-image workflow below; do not run the npm/GHCR examples as availability claims.

## Packages (reserved names; pending P1-B)

| Package | npm | Description |
|---------|-----|-------------|
| [`@kyan-du/agent-wechat-cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@kyan-du/agent-wechat-cli)](https://www.npmjs.com/package/@kyan-du/agent-wechat-cli) | CLI for managing the Docker container and interacting with WeChat |
| [`@kyan-du/agent-wechat-wechaty-puppet`](./packages/wechaty-puppet) | [![npm](https://img.shields.io/npm/v/@kyan-du/agent-wechat-wechaty-puppet)](https://www.npmjs.com/package/@kyan-du/agent-wechat-wechaty-puppet) | [Wechaty](https://wechaty.js.org) puppet for agent-wechat |
| [`@kyan-du/agent-wechat-openclaw`](./packages/openclaw-extension) | [![npm](https://img.shields.io/npm/v/@kyan-du/agent-wechat-openclaw)](https://www.npmjs.com/package/@kyan-du/agent-wechat-openclaw) | [OpenClaw](https://openclaw.ai) extension for AI agent integration |

## What It Does

- **Read** chats, messages, and media (images, voice, files) via REST API
- **Send** text messages, images, and files
- **Login** via QR code displayed in your terminal
- **Monitor** for new messages in real-time

## Requirements

- Docker (Colima on macOS, or Docker Desktop)
- Node.js >= 22 (for CLI)
- pnpm (for development)
- **Not compatible with serverless environments** — requires ptrace capabilities

## Quick Start from source

```bash
git clone https://github.com/kyan-du/agent-wechat.git
cd agent-wechat
pnpm install
pnpm build
pnpm build:image

# Start the locally built container
pnpm cli start

# Login (displays QR code in terminal)
pnpm cli auth login

# List your chats
pnpm cli chats

# Send a message
pnpm cli send <chatId> --text "Hello"

# Read messages
pnpm cli messages <chatId>

# Stop the container
pnpm cli stop
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `pnpm cli start [--proxy user:pass@host:port] [--image <reference>]` | Start a local image, or an explicit published fork version/digest |
| `pnpm cli stop` | Stop and remove container |
| `pnpm cli logs` | Stream container logs |
| `pnpm cli status` | Show server and login status |
| `pnpm cli auth login` | Login flow (shows QR code) |
| `pnpm cli chats` | List chats |
| `pnpm cli find <name>` | Find chat by name |
| `pnpm cli messages <id>` | List messages in a chat |
| `pnpm cli send <id> --text <msg>` | Send text message |
| `pnpm cli send <id> --image <file>` | Send image |
| `pnpm cli messages media <id> <localId>` | Download media attachment |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                Docker Container                     │
│                                                     │
│   WeChat Linux  ←──  Xvfb + AT-SPI (accessibility)  │
│        ↕                                            │
│   agent-server (Rust/Axum, port 6174)               │
│     - FSM engine for UI automation                  │
│     - REST + WebSocket API                          │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / WebSocket
                       ↓
               CLI or AI agent
```

- **UI automation**: Login, open chats, send messages — all via deterministic FSM (no LLM needed)
- **API**: REST endpoints for all operations, WebSocket for login flow and events

## Docker Setup

**Option A: locally built image via CLI** (available now)

```bash
pnpm build:image
pnpm cli start    # uses agent-wechat:<host architecture>
```

**Option B: local image with Docker Compose** (for custom networking)

See [`docker-compose.yml`](./docker-compose.yml) for a full example. Key points:

```yaml
# Generate a token and device identity first:
#   mkdir -p ~/.config/agent-wechat
#   openssl rand -hex 32 > ~/.config/agent-wechat/token
#   chmod 600 ~/.config/agent-wechat/token
#   eval "$(./scripts/device-identity.sh)"

services:
  agent-wechat:
    image: agent-wechat:${AGENT_WECHAT_ARCH:-amd64}
    hostname: ${AGENT_WECHAT_HOSTNAME:?run scripts/device-identity.sh}
    mac_address: ${AGENT_WECHAT_MAC:?run scripts/device-identity.sh}
    security_opt:
      - seccomp=unconfined
    cap_add:
      - SYS_PTRACE
      - NET_ADMIN           # for transparent proxy (optional)
    ports:
      - "6174:6174"
    volumes:
      - agent-wechat-data:/data
      - agent-wechat-home:/home/wechat
      - ~/.config/agent-wechat/token:/data/auth-token:ro
    environment:
      - PROXY=${PROXY:-}    # optional: user:pass@host:port
      - AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY=${AGENT_WECHAT_OUTBOUND_QUEUE_CAPACITY:-20}
      - AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS=${AGENT_WECHAT_OUTBOUND_MIN_SPACING_MS:-1500}
      - AGENT_WECHAT_OUTBOUND_JITTER_MS=${AGENT_WECHAT_OUTBOUND_JITTER_MS:-250}
      - AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS=${AGENT_WECHAT_OUTBOUND_LONG_TAIL_JITTER_MS:-4000}
      - AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT=${AGENT_WECHAT_OUTBOUND_LONG_TAIL_CHANCE_PERCENT:-8}
      - AGENT_WECHAT_TEXT_CHUNK_CHARS=${AGENT_WECHAT_TEXT_CHUNK_CHARS:-24}
      - AGENT_WECHAT_TEXT_CHUNK_PAUSE_MS=${AGENT_WECHAT_TEXT_CHUNK_PAUSE_MS:-45}
      - AGENT_WECHAT_TEXT_CHUNK_JITTER_MS=${AGENT_WECHAT_TEXT_CHUNK_JITTER_MS:-80}
      - AGENT_WECHAT_SIMILARITY_WINDOW_MS=${AGENT_WECHAT_SIMILARITY_WINDOW_MS:-600000}
      - AGENT_WECHAT_SIMILARITY_MIN_CHARS=${AGENT_WECHAT_SIMILARITY_MIN_CHARS:-20}
      - AGENT_WECHAT_SIMILARITY_HAMMING=${AGENT_WECHAT_SIMILARITY_HAMMING:-8}
      - AGENT_WECHAT_SIMILARITY_HISTORY=${AGENT_WECHAT_SIMILARITY_HISTORY:-200}
      - AGENT_WECHAT_OUTBOUND_DISABLED=${AGENT_WECHAT_OUTBOUND_DISABLED:-false}
      - AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS=${AGENT_WECHAT_OUTBOUND_IDEMPOTENCY_MAX_ROWS:-10000}
      - AGENT_WECHAT_MACHINE_ID=${AGENT_WECHAT_MACHINE_ID:?run scripts/device-identity.sh}
      - AGENT_WECHAT_HOSTNAME=${AGENT_WECHAT_HOSTNAME:?run scripts/device-identity.sh}
      - AGENT_WECHAT_MAC=${AGENT_WECHAT_MAC:?run scripts/device-identity.sh}
    restart: unless-stopped

volumes:
  agent-wechat-data:
  agent-wechat-home:
```

Outbound text requests are scheduled with round-robin fairness across both
`source` and chat. OpenClaw and Wechaty set their source automatically; direct
API callers may use a 1-64 character ASCII `source`. Long text is pasted in
Unicode-safe chunks with bounded pauses (texts above 4096 characters use one
paste to keep the action plan bounded). Any pre-commit text-input failure clears
the partial composer draft; cleanup is never attempted after an uncertain commit.
Image/file sends remain unchanged.
If a text-only request resembles another recent outbound message, the API
returns `SIMILAR_CONTENT_CONFIRMATION_REQUIRED`; after reviewing the exact
recipient and text, an operator can rerun CLI with `--confirm-similar`, call the
OpenClaw `wechat_send_confirmed` tool with `confirmed: true`, use Wechaty's
`messageSendTextConfirmed(..., true)`, or set raw REST `similarityConfirmed:
true`. None of the normal automation paths confirms or retries automatically.
Similarity history is memory-only and retains fingerprints, not message text.

## Development

```bash
pnpm install
pnpm build                   # Build CLI + shared types
pnpm dev:deploy              # Cross-compile Rust server + deploy to running container
pnpm build:image:arm64       # Build Docker image (Apple Silicon)
pnpm build:image:amd64       # Build Docker image (Intel)
```

### Build a pullable image from any branch before merging

GitHub Actions provides a manual **Build Docker Image from Ref** workflow. In
Actions, choose `Build Docker Image from Ref`, enter a branch, tag, or full
commit SHA. The workflow builds
both `linux/amd64` and `linux/arm64`, then publishes an immutable GHCR tag
using the resolved production seven-character commit ID:

```text
ghcr.io/kyan-du/agent-wechat:<resolved-sha7>
```

The tag is the exact first seven characters of the resolved commit ID. The
workflow summary prints the exact `docker pull`, digest-pinned pull, and
`docker run` commands. The commit tag binds the image to the resolved commit.
This is a disposable
validation artifact, not a semver release; it never moves `latest`, `next`, or
release tags.

For a pull request, use the PR head branch or full head SHA as `ref`, then use
the digest-pinned command from the run summary for local verification. The
workflow requires `packages: write`; the first publication may also require
making the GHCR package visible to the intended pull client.

## Runtime constraints (experimental)

These are experimental fingerprint and pacing changes. They are not a guarantee the account stays unrestricted. Do not trial them on a primary account.

- One account, one persistent device identity (`machine-id` / hostname / MAC). `wx start` writes this once and passes hostname/MAC at create time. Compose: `eval "$(./scripts/device-identity.sh)"` before `docker compose up` — the script emits `export KEY=value` so Compose interpolation can see them. Hostname/MAC cannot be changed from inside the container. A mismatched identity aborts the entrypoint before WeChat starts.
- Prefer a stable residential exit in the same city as the phone. Do not rotate the proxy mid-session. Do not share one IP across accounts.
- Sends go through the outbound queue: spacing, chat cooldown, hourly/daily budgets, quiet hours (00:30–07:30 local), and a reading delay when callers pass `inboundChars`. After reconnect, at most `catchUpChatBudget` chats (default 5) auto-reply, one per poll. Leftovers stay in reconnect-hold (`catchup_hold`) and are not flipped to a live burst. Raise `channels.agent-wechat.catchUpChatBudget` (hot-reload) to continue the hold, or handle the remaining unread chats yourself.
- A security/verification popup pauses outbound. Recover with `POST /api/status/outbound/resume` after you handle it yourself.

See GitHub issue #7 for the remaining P2 fingerprint work.

See [CLAUDE.md](./CLAUDE.md) for full technical documentation.

## Ports

| Port | Service |
|------|---------|
| 6174 | Agent server REST API + VNC web viewer at `/vnc/` |
