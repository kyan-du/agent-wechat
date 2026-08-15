> **Release boundary:** Fork npm, GHCR, and hosted-docs channels remain unavailable until P1-B publishes and verifies them. Use the repository source/local-build path in the meantime.

# @kyan-du/agent-wechat-cli

Command-line tool for managing agent-wechat containers and interacting with WeChat.

**[Documentation](https://kyan-du.github.io/agent-wechat/getting-started/cli/commands/)**

## Install from source (current P1-A path)

```bash
# Pending P1-B (not available yet): npm install -g @kyan-du/agent-wechat-cli
git clone https://github.com/kyan-du/agent-wechat.git
cd agent-wechat
corepack enable && pnpm install --frozen-lockfile
pnpm build && pnpm build:image
```

Until P1-B publishes and verifies npm/GHCR, run every CLI command as `pnpm cli -- <arguments>` from this checkout.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running

`wx up` uses the locally built `agent-wechat:arm64` or `agent-wechat:amd64` image by default. After P1-B publishes fork images, select one exactly with `wx up --image ghcr.io/kyan-du/agent-wechat:1.2.3` or `wx up --image ghcr.io/kyan-du/agent-wechat@sha256:<64-lowercase-hex>`. No `latest` or default-registry fallback is used.

> **Note:** agent-wechat requires `SYS_PTRACE` and `seccomp=unconfined` to interact with the WeChat desktop process. It cannot run in serverless or restricted container environments (AWS Fargate, Cloud Run, etc.). Use a VM or bare-metal Docker host.

## Quick Start

```bash
# Start the container
pnpm cli -- up

# Check status
pnpm cli -- status

# Log in (displays QR code in terminal)
pnpm cli -- auth login

# List chats
pnpm cli -- chats list

# Send a message
pnpm cli -- messages send <chatId> --text "Hello"
# Only after reviewing a SIMILAR_CONTENT_CONFIRMATION_REQUIRED response:
pnpm cli -- messages send <chatId> --text "Reviewed text" --confirm-similar
```

## Commands

### Container

| Command | Description |
|---------|-------------|
| `wx up [--proxy user:pass@host:port] [--image <reference>]` | Start the local image or an explicit published fork semver/digest |
| `wx down` | Stop and remove the container |
| `wx logs` | Tail container logs |
| `wx status` | Show container up/down status and login status (when available) |

### Auth

| Command | Description |
|---------|-------------|
| `wx auth login` | Log in to WeChat (shows QR code) |
| `wx auth logout` | Log out of WeChat |
| `wx auth status` | Check login status |
| `wx auth token` | Show current auth token |
| `wx auth token --regenerate` | Generate a new auth token |

Login options:
- `--timeout <seconds>` — login timeout (default: 300)
- `--new` — switch to a new account instead of existing

### Chats

| Command | Description |
|---------|-------------|
| `wx chats list` | List chats from WeChat |
| `wx chats get <chatId>` | Get details for a specific chat |
| `wx chats find <name>` | Search chats by display name |
| `wx chats open <chatId>` | Open a chat in the WeChat UI |

Options: `--limit <n>`, `--offset <n>`, `--json`

### Messages

| Command | Description |
|---------|-------------|
| `wx messages list <chatId>` | List messages in a chat |
| `wx messages send <chatId>` | Send a message |
| `wx messages media <chatId> <localId>` | Download a media attachment |

Send options:
- `--text "message"` — send text
- `--image photo.jpg` — send an image
- `--file document.pdf` — send a file

Media options:
- `--output <path>` — save to a specific file path

### Sessions

| Command | Description |
|---------|-------------|
| `wx session list` | List all sessions |
| `wx session create <name>` | Create a new session |
| `wx session start <id>` | Start a session |
| `wx session stop <id>` | Stop a session |
| `wx session delete <id>` | Delete a session |

### Debug

| Command | Description |
|---------|-------------|
| `wx screenshot [file]` | Save a screenshot (default: screenshot.png) |
| `wx a11y` | Dump the accessibility tree (`--format json|aria`) |

## Global Options

| Option | Description |
|--------|-------------|
| `-s, --session <name>` | Use a specific session (default: "default") |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

## Configuration

The CLI reads configuration from environment variables and a local token file:

| Source | Description |
|--------|-------------|
| `AGENT_WECHAT_URL` | Server URL (default: `http://localhost:6174`) |
| `AGENT_WECHAT_TOKEN` | Auth token (overrides token file) |
| `~/.config/agent-wechat/token` | Auto-generated auth token |

The auth token is generated automatically on first run and shared with the container via a read-only volume mount.

## Running the Container

There are two ways to run the agent-wechat container.

> **Note:** agent-wechat requires `SYS_PTRACE` and `seccomp=unconfined` because it uses ptrace to interact with the WeChat desktop process. It cannot run in serverless or restricted container environments (AWS Fargate, Cloud Run, Azure Container Instances, etc.). Use a VM or bare-metal Docker host.

### Option 1: `wx up` (local development)

The simplest way. `wx up` starts the architecture-specific local image (or pulls only an explicitly selected fork semver/digest) with the right flags, volume mounts, and auth token:

```bash
pnpm cli -- up
```

This starts a container named `agent-wechat` with:
- **Port 6174** — REST API + VNC web viewer at `/vnc/` (exposed to all interfaces)
- Persistent volumes for data and WeChat home directory
- Auth token from `~/.config/agent-wechat/token` (auto-generated on first run)

To route all container traffic through a proxy:

```bash
pnpm cli -- up --proxy user:pass@host:port
```

This sets up a transparent proxy (redsocks + iptables) inside the container — invisible to WeChat. Prefix with `socks5://` for SOCKS5 proxies.

### Option 2: Docker Compose (production / networked)

For production or when running alongside other services (e.g., OpenClaw), use the `docker-compose.yml` in the repo root as a reference:

```yaml
services:
  agent-wechat:
    image: agent-wechat:${AGENT_WECHAT_ARCH:-amd64}
    container_name: agent-wechat
    security_opt:
      - seccomp=unconfined
    cap_add:
      - SYS_PTRACE
      - NET_ADMIN
    ports:
      - "6174:6174"
    volumes:
      - agent-wechat-data:/data
      - agent-wechat-home:/home/wechat
      - ~/.config/agent-wechat/token:/data/auth-token:ro
    environment:
      - PROXY=${PROXY:-}    # optional: user:pass@host:port
    restart: unless-stopped

volumes:
  agent-wechat-data:
  agent-wechat-home:
```

Generate a token before starting:

```bash
mkdir -p ~/.config/agent-wechat
openssl rand -hex 32 > ~/.config/agent-wechat/token
chmod 600 ~/.config/agent-wechat/token
```

If running alongside OpenClaw on the same Docker network, set `serverUrl` to `http://agent-wechat:6174` in your OpenClaw config.

### Building locally

To build the Docker image from source instead of pulling from ghcr.io:

```bash
# From the repo root — auto-detects host architecture
pnpm build:image

# Or specify architecture
pnpm build:image:arm64
pnpm build:image:amd64
```
