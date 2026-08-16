#!/usr/bin/env bash
set -euo pipefail

# Download the exact audited WeChat .deb for local inspection only.
# docker/.dockerignore excludes this payload; image builds fetch and verify it independently.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT_DIR/docker/wechat.deb"

case "$(uname -m)" in
  x86_64)        ARCH_SUFFIX="x86_64"; EXPECTED_SHA256="c9765e87ee5133bf4bb50d585c1814fafd995e3fb0da62c5ed07259b43dada7b"; EXPECTED_ARCH="amd64" ;;
  aarch64|arm64) ARCH_SUFFIX="arm64"; EXPECTED_SHA256="c3ed1a481247e6a1b166e87a66cccdee898c3ae0b76613b39bb6e9795e50929f"; EXPECTED_ARCH="arm64" ;;
  *)
    echo "Unknown architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

URL="https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_${ARCH_SUFFIX}.deb"

verify_payload() {
  echo "$EXPECTED_SHA256  $1" | shasum -a 256 --check
  test "$(dpkg-deb -f "$1" Package)" = wechat
  test "$(dpkg-deb -f "$1" Version)" = 4.1.1.8
  test "$(dpkg-deb -f "$1" Architecture)" = "$EXPECTED_ARCH"
}

if [ -f "$OUT" ]; then
  echo "Validating cached docker/wechat.deb..."
  verify_payload "$OUT"
  echo "Cached audited WeChat 4.1.1.8 package is valid."
  exit 0
fi

echo "Downloading WeChat for ${ARCH_SUFFIX}..."
tmp="${OUT}.partial"
trap 'rm -f "$tmp"' EXIT
curl --fail --location --retry 3 -o "$tmp" "$URL"
verify_payload "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
echo "Saved audited WeChat 4.1.1.8 to docker/wechat.deb ($(du -h "$OUT" | cut -f1))"
