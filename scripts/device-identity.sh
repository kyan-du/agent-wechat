#!/usr/bin/env bash
# Persist one desktop identity per data dir and print shell assignments.
# Used by Compose before `docker compose up` so hostname/MAC are applied at
# create time (the container cannot change UTS hostname with only NET_ADMIN).
#
# The generator process owns the fcntl lock. SIGKILL/crash closes the fd and
# releases it; there is no helper that can outlive the caller.
set -euo pipefail
exec python3 - "$@" <<'PY'
import fcntl
import os
import re
import shlex
import stat
import sys
import tempfile
import time
import uuid
from typing import Callable, Optional

PREFIXES = ("lenovo-pc", "honor-pc", "xiaomi-pc", "asus-pc", "dell-pc", "hp-pc", "thinkpad")
MACHINE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")


def die(message: str) -> None:
    print(f"[identity] {message}", file=sys.stderr)
    raise SystemExit(1)


def valid_machine_id(value: str) -> bool:
    return "\n" not in value and "\r" not in value and bool(MACHINE_ID_RE.fullmatch(value))


def valid_hostname(value: str) -> bool:
    return (
        "\n" not in value
        and "\r" not in value
        and 1 <= len(value) <= 63
        and bool(HOSTNAME_RE.fullmatch(value))
    )


def valid_mac(value: str) -> bool:
    if "\n" in value or "\r" in value or not MAC_RE.fullmatch(value):
        return False
    return int(value.split(":", 1)[0], 16) % 2 == 0


def validate_override(name: str, value: Optional[str], checker: Callable[[str], bool]) -> Optional[str]:
    if not value:
        return None
    if not checker(value):
        die(f"invalid {name} override")
    return value


def parse_identity_file(path: str) -> tuple[str, str, str]:
    data = open(path, "rb").read()
    if b"\0" in data:
        die(f"NUL in {path}")
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        die(f"non-ascii identity in {path}")
    mid = hn = mac = None
    for line in text.splitlines():
        if line.startswith("AGENT_WECHAT_MACHINE_ID="):
            if mid is not None:
                die(f"duplicate AGENT_WECHAT_MACHINE_ID in {path}")
            value = line[len("AGENT_WECHAT_MACHINE_ID=") :]
            if not valid_machine_id(value):
                die(f"invalid AGENT_WECHAT_MACHINE_ID in {path}")
            mid = value
        elif line.startswith("AGENT_WECHAT_HOSTNAME="):
            if hn is not None:
                die(f"duplicate AGENT_WECHAT_HOSTNAME in {path}")
            value = line[len("AGENT_WECHAT_HOSTNAME=") :]
            if not valid_hostname(value):
                die(f"invalid AGENT_WECHAT_HOSTNAME in {path}")
            hn = value
        elif line.startswith("AGENT_WECHAT_MAC="):
            if mac is not None:
                die(f"duplicate AGENT_WECHAT_MAC in {path}")
            value = line[len("AGENT_WECHAT_MAC=") :]
            if not valid_mac(value):
                die(f"invalid AGENT_WECHAT_MAC in {path}")
            mac = value
        else:
            die(f"unexpected line in {path}")
    if not (mid and hn and mac):
        die(f"incomplete identity in {path}")
    return mid, hn, mac


def derive_hostname(mid: str) -> str:
    idx = int(mid[0:2], 16) % len(PREFIXES)
    num = int(mid[2:6], 16) % 900 + 100
    return f"{PREFIXES[idx]}-{num}"


def derive_mac(mid: str) -> str:
    return f"00:1b:21:{mid[6:8]}:{mid[8:10]}:{mid[10:12]}"


def write_identity_atomic(env_file: str, mid: str, hn: str, mac: str) -> None:
    directory = os.path.dirname(env_file)
    fd, tmp = tempfile.mkstemp(prefix="device-identity.env.", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        payload = (
            f"AGENT_WECHAT_MACHINE_ID={mid}\n"
            f"AGENT_WECHAT_HOSTNAME={hn}\n"
            f"AGENT_WECHAT_MAC={mac}\n"
        ).encode("ascii")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, env_file)
    os.chmod(env_file, 0o600)


def acquire_lock(lock_path: str) -> int:
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        die(f"cannot open lock {lock_path}: {exc}")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            die(f"{lock_path} is not a regular file")
        fcntl.flock(fd, fcntl.LOCK_EX)
    except Exception:
        os.close(fd)
        raise
    return fd


def main() -> None:
    ident_dir = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get("AGENT_WECHAT_IDENTITY_DIR")
        or os.path.join(os.path.expanduser("~"), ".config", "agent-wechat")
    )
    os.makedirs(ident_dir, exist_ok=True)
    env_file = os.path.join(ident_dir, "device-identity.env")
    lock_path = os.path.join(ident_dir, ".device-identity.lock")
    lock_fd = acquire_lock(lock_path)
    try:
        hold_ms = int(os.environ.get("AGENT_WECHAT_IDENTITY_HOLD_MS") or "0")
    except ValueError:
        hold_ms = 0

    try:
        if os.path.isfile(env_file):
            mid, hn, mac = parse_identity_file(env_file)
        else:
            mid = validate_override(
                "AGENT_WECHAT_MACHINE_ID",
                os.environ.get("AGENT_WECHAT_MACHINE_ID"),
                valid_machine_id,
            )
            hn = validate_override(
                "AGENT_WECHAT_HOSTNAME",
                os.environ.get("AGENT_WECHAT_HOSTNAME"),
                valid_hostname,
            )
            mac = validate_override(
                "AGENT_WECHAT_MAC",
                os.environ.get("AGENT_WECHAT_MAC"),
                valid_mac,
            )
            if mid is None:
                mid = uuid.uuid4().hex
            if not valid_machine_id(mid):
                die("generated machine-id is invalid")
            if hn is None:
                hn = derive_hostname(mid)
            if mac is None:
                mac = derive_mac(mid)
            if not valid_hostname(hn):
                die("generated hostname is invalid")
            if not valid_mac(mac):
                die("generated MAC is invalid")
            write_identity_atomic(env_file, mid, hn, mac)
            mid, hn, mac = parse_identity_file(env_file)
        if hold_ms > 0:
            time.sleep(hold_ms / 1000.0)
    finally:
        # Keep lock_fd alive until process exit so a crash still releases it.
        os.close(lock_fd)

    print(f"export AGENT_WECHAT_MACHINE_ID={shlex.quote(mid)}")
    print(f"export AGENT_WECHAT_HOSTNAME={shlex.quote(hn)}")
    print(f"export AGENT_WECHAT_MAC={shlex.quote(mac)}")


if __name__ == "__main__":
    main()
PY
