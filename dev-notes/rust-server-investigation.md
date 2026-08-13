# Investigation: Replacing Node.js Agent Server with Rust

## Current Image Size Breakdown (Estimated)

| Component | Estimated Size | Notes |
|-----------|---------------|-------|
| Ubuntu 22.04 base | ~77 MB | Required regardless |
| X11/display stack | ~50 MB | Xvfb, fluxbox, x11vnc, xdotool, scrot |
| WeChat + deps | ~300 MB | WeChat .deb + GTK/NSS/audio libs |
| Python3 + AT-SPI + frida | ~400 MB | frida-tools alone is ~200 MB |
| fonts-noto-cjk | ~120 MB | CJK font pack |
| ffmpeg | ~100 MB | Media conversion |
| **Node.js 22 + pnpm + node-gyp** | **~200 MB** | Runtime + package manager + build tools |
| **node_modules (prod)** | **~50 MB** | better-sqlite3, drizzle, trpc, ws, etc. |
| **g++ / make / python3 (build tools)** | **~150 MB** | Only needed for node-gyp native rebuilds |
| SQLCipher (from source) | ~5 MB | Just the binary after cleanup |
| Audio stack | ~40 MB | PulseAudio, GStreamer, ALSA |

**Node.js total footprint: ~400 MB** (runtime + build tools + node_modules)

Replacing Node.js with a statically-compiled Rust binary would eliminate the entire Node.js stack. The Rust binary itself would be ~10-20 MB.

**Estimated savings: ~380 MB** (roughly 25-30% of a ~1.3 GB image)

## What the Server Does (Scope of Rewrite)

The agent-server (~52 TypeScript files) handles:

1. **HTTP API** (tRPC) — 6 routers: status, chats, messages, events, debug, sessions
2. **WebSocket subscriptions** — login events (QR, phone confirm, success)
3. **FSM engine** — observe→identify→reduce→effects→persist→select→execute→goal loop
4. **State machine** — 10+ UI states (login_qr, login_account, chat, popup, etc.)
5. **Plans** — login, chat-open, send-message, auth-status
6. **SQLite via Drizzle** — 4 tables (sessions, wechat_keys, sync_state, context)
7. **Tool execution** — shells out to /opt/tools/* (screenshot, a11y-dump, click, type, key, scroll)
8. **WeChat DB reads** — query encrypted SQLite DBs via sqlcipher CLI
9. **QR decode/encode** — jsqr for reading screenshots, qrcode for terminal display
10. **Session management** — multi-user support

## Rust Crate Mapping

| Node.js Dep | Purpose | Rust Replacement | Maturity |
|-------------|---------|-----------------|----------|
| `@trpc/server` + `ws` | HTTP + WebSocket API | **axum** (built-in WS) | Very High |
| `better-sqlite3` | SQLite driver | **rusqlite** `bundled-sqlcipher-vendored-openssl` | Very High |
| `drizzle-orm` | ORM + migrations | **rusqlite** directly (4 simple tables) | Very High |
| `dbus-next` | D-Bus for AT-SPI | **zbus** 5.x | Very High |
| (a11y-dump tool) | Accessibility tree | **atspi** 0.25.x (in-process, no subprocess) | High |
| `pngjs` | PNG handling | **image** 0.25.x | Very High |
| `jsqr` | QR decode | **rqrr** | Good |
| `qrcode` | QR encode | **qrcode** (Rust) 0.14.x | Good |
| `fzstd` | Zstandard decompress | **zstd** 0.13.x | Very High |
| `superjson` + `zod` | Serialization + validation | **serde** + **serde_json** | Very High |
| Node.js event loop | Async runtime | **tokio** 1.x | Very High |
| (xdotool scripts) | X11 input automation | **enigo** 0.6.x | Moderate |
| (scrot script) | Screenshot | **x11rb** 0.13.x | Good |

## Three Approaches

### Option A: Full Rust Rewrite (Maximum savings, highest effort)

Replace the entire agent-server with Rust. All FSM logic, plans, a11y querying, tool execution becomes native Rust code.

**Pros:**
- Eliminates Node.js entirely (~380 MB savings)
- In-process AT-SPI via `atspi` + `zbus` — no more shelling out to Python `a11y_dump.py`
- In-process X11 via `enigo` + `x11rb` — no more shelling out to xdotool/scrot
- FSM loop runs much faster (no subprocess overhead per iteration)
- Rust's type system encodes the state machine at compile time
- Single static binary, no dependency management

**Cons:**
- ~52 TypeScript files to rewrite (~4-6K lines of logic)
- Must keep Python scripts for Frida (extract-keys.py) and media conversion — no Rust Frida bindings
- `atspi` crate is actively maintained but pre-1.0 (0.25.x)
- `enigo` is moderate maturity — may need fallback to subprocess for edge cases
- CLI package also needs rewriting (or keep TypeScript CLI calling Rust server)

**Image savings:** ~380 MB (remove nodejs, pnpm, node-gyp, g++, make, node_modules)

**Additional savings opportunity:** If a11y is done in-process via `atspi`, you could potentially drop `python3-gi` and `gir1.2-atspi-2.0` (the Python AT-SPI bindings), saving another ~20 MB. However, `python3` is still needed for Frida scripts and media conversion.

### Option B: Hybrid — Rust Server, Keep Tool Scripts (Moderate savings, moderate effort)

Rewrite the server (HTTP + FSM + DB) in Rust but keep the existing shell/Python tool scripts. The Rust server shells out to `/opt/tools/*` just like Node.js does today.

**Pros:**
- Still eliminates Node.js runtime (~380 MB savings)
- Lower risk — tool scripts are proven, just changing the orchestrator
- Incremental: can move tool calls in-process later
- CLI can remain TypeScript (tRPC client → axum JSON API)

**Cons:**
- Still has subprocess overhead per FSM iteration (screenshot + a11y-dump + action = 3 spawns per loop)
- Python + xdotool + scrot still required in image
- Still ~52 files of FSM logic to port

**Image savings:** ~380 MB (same as Option A — Node.js stack removed)

### Option C: Minimal — Just Replace the HTTP Layer (Least effort)

Keep the FSM logic in TypeScript, compile it to a standalone binary using Bun or Deno, or use `pkg`/`sea` (Node.js Single Executable Application) to bundle everything.

**Pros:**
- Near-zero rewrite effort
- Node.js SEA or Bun compile produces a single binary
- Can remove pnpm, node-gyp, g++, make from the image

**Cons:**
- Node.js runtime is still bundled inside the SEA binary (~50-80 MB)
- Bun binary is ~90 MB
- Savings are smaller (~150-200 MB for build tools only)
- Doesn't address the subprocess overhead

**Image savings:** ~150-200 MB (remove build tools, keep embedded runtime)

## Recommendation

**Option B (Hybrid)** is the best starting point:

1. It gets the full ~380 MB image savings from removing Node.js
2. It's lower risk because proven tool scripts stay unchanged
3. The FSM logic ports cleanly — Rust enums map naturally to the `Action` union type, and `match` exhaustiveness replaces runtime checks
4. You can incrementally move to Option A by replacing tool script calls with in-process `atspi`/`enigo`/`x11rb` calls one at a time

### Suggested Implementation Order

1. **Set up axum server** with basic routes (status, debug/screenshot, debug/a11y)
2. **Port the database layer** — rusqlite with migrations, 4 tables
3. **Port the FSM types** — `AppState`, `Action`, `IAState`, `Plan` as Rust enums/traits
4. **Port tool execution** — `tokio::process::Command` calling `/opt/tools/*`
5. **Port the a11y selector engine** — CSS-like querySelector over JSON a11y tree
6. **Port states** — login, chat, popup, contact-card (identify + reduce + commands)
7. **Port plans** — login, chat-open, send-message, auth-status
8. **Port the execution loop** — observe→identify→reduce→effects→persist→select→execute→goal
9. **Port routers** — chats, messages, sessions, events (WebSocket subscriptions)
10. **Port WeChat DB access** — sqlcipher queries for chats, messages, media
11. **Update Dockerfile** — remove Node.js, add Rust binary COPY
12. **Update CLI** — point at new JSON API (or rewrite in Rust with clap)

### Cargo.toml Skeleton

```toml
[package]
name = "agent-server"
version = "0.1.0"
edition = "2021"

[dependencies]
# Async runtime
tokio = { version = "1", features = ["full"] }

# HTTP server + WebSocket
axum = { version = "0.8", features = ["ws"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "trace"] }

# Serialization
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Database (SQLite + SQLCipher)
rusqlite = { version = "0.32", features = ["bundled-sqlcipher-vendored-openssl"] }

# Image processing + QR
image = "0.25"
rqrr = "0.8"
qrcode = "0.14"

# Zstandard
zstd = "0.13"

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"
```

Optional (for in-process X11/AT-SPI — move from Option B → A):

```toml
# D-Bus + Accessibility (replaces a11y-dump tool script)
zbus = { version = "5", features = ["tokio"] }
atspi = { version = "0.25", features = ["proxies", "connection", "tokio"] }

# X11 automation (replaces xdotool/scrot tool scripts)
enigo = "0.6"
x11rb = "0.13"
```

## Things That Must Stay as Python/Shell

Regardless of approach, these components must remain:

| Component | Why |
|-----------|-----|
| `extract-keys.py` | Frida has no Rust bindings; memory scanning of WeChat process |
| `chat-select.py` | Uses Frida for current-selection tracking |
| `media-convert.py` | WXGF/SILK conversion (silk-python, ffmpeg) |
| `sqlcipher` binary | Needed for reading encrypted WeChat DBs (unless rusqlite's sqlcipher handles it) |
| `entrypoint.sh` | Orchestrates Xvfb, D-Bus, fluxbox, WeChat startup |

Note: If using `rusqlite` with `bundled-sqlcipher`, the `sqlcipher` CLI binary is no longer needed for WeChat DB reads — rusqlite can open encrypted databases directly with `PRAGMA key`. This would remove the need to compile sqlcipher from source in the Dockerfile.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `atspi` crate is pre-1.0 | Start with Option B (keep Python a11y-dump), migrate later |
| `enigo` edge cases | Keep tool scripts as fallback, replace incrementally |
| WeChat DB access complexity | rusqlite + sqlcipher is well-proven; test key extraction flow |
| TypeScript CLI compatibility | axum serves JSON — any HTTP client works; CLI stays as-is |
| FSM correctness | Port tests alongside logic; run both servers in parallel during migration |
