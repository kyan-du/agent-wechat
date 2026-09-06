# ============================================
# Stage 1: Build the Rust server binary
# ============================================
FROM rust:1.93-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31 AS builder

ARG BUILD_MODE=release
ARG VERSION

WORKDIR /build

# pkg-config is already present in the digest-pinned Rust image. Avoid mutable
# Debian repository resolution in the builder and fail closed if that changes.
RUN command -v pkg-config \
    && test "$(dpkg-query -W -f='${Version}' pkg-config)" = "1.8.1-1"

# Copy manifests first for dependency caching
COPY agent-server-rust/Cargo.toml agent-server-rust/Cargo.lock* ./
# Inject the release version before Cargo compiles env!("CARGO_PKG_VERSION").
# The prerelease workflow passes the exact tag (for example 0.13.4-next.3).
# Validation and local debug builds may omit VERSION and use the checked-in
# package version instead.
RUN if [ -n "$VERSION" ]; then \
      sed -i "0,/^version = .*/s//version = \"$VERSION\"/" Cargo.toml; \
    fi
# Create dummy src for dependency build
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN if [ "$BUILD_MODE" = "debug" ]; then cargo build 2>/dev/null || true; else cargo build --release 2>/dev/null || true; fi
# Remove dummy build artifacts
RUN rm -rf src target/release/deps/agent_server* target/debug/deps/agent_server*

# Copy actual source and migrations, then build
COPY agent-server-rust/src ./src
COPY agent-server-rust/migrations ./migrations
RUN if [ "$BUILD_MODE" = "debug" ]; then cargo build; else cargo build --release; fi

# Copy binary to a known location regardless of build mode
RUN mkdir -p /output && cp target/${BUILD_MODE}/agent-server /output/agent-server

# ============================================
# Stage 2: Final runtime image
# ============================================
FROM ubuntu:22.04@sha256:3b06811b2afd352be909dd088a004166d665dc76d38b13eada33522a9d915c6f

ENV DEBIAN_FRONTEND=noninteractive

# Immutable Ubuntu archive snapshot; Valid-Until is intentionally disabled because the snapshot is frozen.
# Bootstrap TLS from the digest-pinned builder; do not contact a mutable Ubuntu
# mirror merely to obtain CA certificates.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN UBUNTU_SNAPSHOT=20260801T000000Z \
    && printf 'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/%s jammy main restricted universe multiverse\ndeb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/%s jammy-updates main restricted universe multiverse\ndeb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/%s jammy-security main restricted universe multiverse\n' "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" "$UBUNTU_SNAPSHOT" > /etc/apt/sources.list

# ============================================
# System packages
# ============================================
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y \
    # Display
    xvfb fluxbox x11vnc \
    # Input automation
    xdotool scrot \
    # Accessibility
    at-spi2-core gir1.2-atspi-2.0 python3 python3-gi \
    # Notifications
    dunst libnotify-bin \
    # Fonts
    fonts-noto-cjk \
    # System
    dbus dbus-x11 ca-certificates curl \
    # WeChat dependencies (basic)
    libatomic1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnss3 libx11-6 \
    libxkbcommon0 libxkbcommon-x11-0 libxcb-icccm4 \
    libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxss1 \
    # Audio - needed for message notifications
    pulseaudio alsa-base alsa-utils \
    gstreamer1.0-pulseaudio gstreamer1.0-alsa \
    # Media conversion (WXGF→JPEG/GIF, SILK→MP3)
    ffmpeg \
    # Clipboard (for paste-image tool)
    xclip \
    # Transparent proxy
    redsocks iptables \
    # SQLCipher build deps (temp, for compiling sqlcipher CLI)
    libssl-dev build-essential tcl \
    # Python packages for tools
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# Python packages
# ============================================
COPY release-materials/requirements.lock release-materials/frida_tools-14.10.4-py3-none-any.whl /opt/release-inputs/
RUN pip3 install --require-hashes --only-binary=:all: --find-links=/opt/release-inputs -r /opt/release-inputs/requirements.lock
COPY python/ /opt/python-compat/
ENV PYTHONPATH=/opt/python-compat
RUN python3 -c "import frida, sys, typing; assert sys.version_info[:2] == (3, 10); assert getattr(typing, 'NotRequired', None) is not None; assert frida.__version__ == '17.17.0'; print('frida import smoke ok', frida.__version__)"

# ============================================
# noVNC (browser-based VNC viewer) + websockify
# ============================================
RUN NOVNC_VERSION=1.5.0 \
    && NOVNC_URL=https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
    && NOVNC_SHA256=6a73e41f98388a5348b7902f54b02d177cb73b7e5eb0a7a0dcf688cc2c79b42a \
    && curl --fail --location --retry 3 -o /tmp/novnc.tar.gz "$NOVNC_URL" \
    && echo "$NOVNC_SHA256  /tmp/novnc.tar.gz" | sha256sum --check --strict \
    && tar xzf /tmp/novnc.tar.gz -C /opt \
    && mv /opt/noVNC-${NOVNC_VERSION} /opt/novnc \
    && rm /tmp/novnc.tar.gz

# ============================================
# SQLCipher 4 CLI (needed for wechat-db reads)
# ============================================
RUN SQLCIPHER_VERSION=4.6.1 \
    && SQLCIPHER_URL=https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.6.1.tar.gz \
    && SQLCIPHER_SHA256=d8f9afcbc2f4b55e316ca4ada4425daf3d0b4aab25f45e11a802ae422b9f53a3 \
    && cd /tmp \
    && curl --fail --location --retry 3 -o sqlcipher.tar.gz "$SQLCIPHER_URL" \
    && echo "$SQLCIPHER_SHA256  sqlcipher.tar.gz" | sha256sum --check --strict \
    && tar xzf sqlcipher.tar.gz \
    && cd sqlcipher-${SQLCIPHER_VERSION} \
    && ./configure --enable-tempstore=yes CFLAGS="-DSQLITE_HAS_CODEC -DSQLCIPHER_CRYPTO_OPENSSL" LDFLAGS="-lcrypto" \
    && make -j$(nproc) \
    && cp sqlcipher /usr/local/bin/sqlcipher \
    && cd / && rm -rf /tmp/sqlcipher-${SQLCIPHER_VERSION} /tmp/sqlcipher.tar.gz

# ============================================
# X11 socket directory
# ============================================
RUN mkdir -p /tmp/.X11-unix && chown root:root /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# ============================================
# WeChat
# The proprietary payload is fetched from the recorded source and verified
# fail closed. This provenance evidence is not a redistribution grant.
# ============================================
ARG TARGETARCH
RUN WECHAT_VERSION=4.1.1.8 \
    && WECHAT_AMD64_URL=https://web.archive.org/web/20260818044438id_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb \
    && WECHAT_AMD64_SHA256=c9765e87ee5133bf4bb50d585c1814fafd995e3fb0da62c5ed07259b43dada7b \
    && WECHAT_ARM64_URL=https://web.archive.org/web/20260818044442id_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb \
    && WECHAT_ARM64_SHA256=c3ed1a481247e6a1b166e87a66cccdee898c3ae0b76613b39bb6e9795e50929f \
    && case "$TARGETARCH" in \
      amd64) WECHAT_URL="$WECHAT_AMD64_URL"; WECHAT_SHA256="$WECHAT_AMD64_SHA256"; DEB_ARCH=amd64 ;; \
      arm64) WECHAT_URL="$WECHAT_ARM64_URL"; WECHAT_SHA256="$WECHAT_ARM64_SHA256"; DEB_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 -o /tmp/wechat.deb "$WECHAT_URL" \
    && echo "$WECHAT_SHA256  /tmp/wechat.deb" | sha256sum --check --strict \
    && test "$(dpkg-deb -f /tmp/wechat.deb Package)" = wechat \
    && test "$(dpkg-deb -f /tmp/wechat.deb Version)" = "$WECHAT_VERSION" \
    && test "$(dpkg-deb -f /tmp/wechat.deb Architecture)" = "$DEB_ARCH" \
    && (dpkg -i /tmp/wechat.deb || (apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y -f)) \
    && rm -rf /var/lib/apt/lists/* /tmp/wechat.deb

RUN useradd -m -s /bin/bash wechat

# ============================================
# Tool scripts (screenshot, click, type, key, scroll, a11y-dump, etc.)
# ============================================
RUN mkdir -p /opt/tools
COPY tools/ /opt/tools/
RUN chmod +x /opt/tools/*

# ============================================
# Copy Rust binary from builder
# ============================================
COPY --from=builder /output/agent-server /opt/agent-server/agent-server

# ============================================
# Debug support (gdbserver for remote debugging)
# ============================================
ARG BUILD_MODE=release
RUN if [ "$BUILD_MODE" = "debug" ]; then \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y gdbserver && rm -rf /var/lib/apt/lists/*; \
    fi

# ============================================
# Data directory for SQLite
# ============================================
RUN mkdir -p /data && chown wechat:wechat /data
VOLUME /data

# ============================================
# Environment
# ============================================
ENV DISPLAY=:99
ENV PATH="/opt/tools:$PATH"
ENV AGENT_DB_PATH=/data/agent.db
ENV AGENT_PORT=6174

# ============================================
# Entrypoint
# ============================================
COPY entrypoint.sh /entrypoint.sh
COPY identity.sh /opt/identity.sh
COPY reset-device-identity.sh /opt/reset-device-identity.sh
COPY supervise-agent-server.sh /opt/supervise-agent-server.sh
RUN chmod +x /entrypoint.sh /opt/identity.sh /opt/reset-device-identity.sh /opt/supervise-agent-server.sh

EXPOSE 6174 1234

ENTRYPOINT ["/entrypoint.sh"]
