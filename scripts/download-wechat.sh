#!/usr/bin/env bash
set -euo pipefail

# Download the exact audited WeChat .deb for local inspection only.
# docker/.dockerignore excludes this payload; image builds fetch and verify it independently.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT_DIR/docker/wechat.deb"

case "$(uname -m)" in
  x86_64)
    ARCH_SUFFIX="x86_64"
    EXPECTED_SHA256="b7d0f8d53e9f648bc2c77a6096a04100d008f2d9f0d3988a2a4859b5992aca0a"
    EXPECTED_ARCH="amd64"
    URL="https://web.archive.org/web/20260921152423if_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb"
    ;;
  aarch64|arm64)
    ARCH_SUFFIX="arm64"
    EXPECTED_SHA256="51784a262c725ef1595dd833f456190e913583dd81c24dd8fe587532bc91c0dc"
    EXPECTED_ARCH="arm64"
    URL="https://web.archive.org/web/20260921152526if_/https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_arm64.deb"
    ;;
  *)
    echo "Unknown architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

verify_payload() {
  echo "$EXPECTED_SHA256  $1" | shasum -a 256 --check
  test "$(dpkg-deb -f "$1" Package)" = wechat
  test "$(dpkg-deb -f "$1" Version)" = 4.1.13.23
  test "$(dpkg-deb -f "$1" Architecture)" = "$EXPECTED_ARCH"
}

if [ -f "$OUT" ]; then
  echo "Validating cached docker/wechat.deb..."
  verify_payload "$OUT"
  echo "Cached audited WeChat 4.1.13.23 package is valid."
  exit 0
fi

echo "Downloading WeChat for ${ARCH_SUFFIX}..."
tmp="${OUT}.partial"
trap 'rm -f "$tmp"' EXIT
curl --fail --location --retry 3 -o "$tmp" "$URL"
verify_payload "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
echo "Saved audited WeChat 4.1.13.23 to docker/wechat.deb ($(du -h "$OUT" | cut -f1))"
