#!/usr/bin/env python3
"""Shared helpers for WeChat extract scripts. Never print account keys or heap."""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys

FRIDA_PYTHON_BOOTSTRAP = (
    "import typing, typing_extensions; "
    "typing.NotRequired = getattr(typing, 'NotRequired', typing_extensions.NotRequired); "
    "typing.Required = getattr(typing, 'Required', typing_extensions.Required); "
    "from frida_tools.repl import main; main()"
)

ELF_EM_AARCH64 = 183
ELF_EM_X86_64 = 62


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit_json(payload: dict, ok: bool | None = None) -> None:
    out = dict(payload)
    if ok is not None:
        out["ok"] = ok
    print(json.dumps(out, sort_keys=True), flush=True)


def find_wechat_pid(explicit: int | None = None) -> int | None:
    if explicit:
        return explicit
    seen = []
    for cmd in (["pgrep", "-x", "wechat"], ["pgrep", "-f", "/opt/wechat/wechat"]):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        except OSError:
            continue
        for tok in result.stdout.strip().split():
            try:
                pid = int(tok)
            except ValueError:
                continue
            if pid in seen:
                continue
            seen.append(pid)
    for pid in seen:
        try:
            with open(f"/proc/{pid}/status", encoding="utf-8") as fh:
                status = fh.read()
        except OSError:
            continue
        if "\nState:\tZ" in status or status.startswith("State:\tZ"):
            continue
        return pid
    return seen[0] if seen else None


def find_wechat_path(pid: int, fallback: str = "/opt/wechat/wechat") -> str | None:
    mapped = None
    try:
        with open(f"/proc/{pid}/maps", encoding="utf-8") as maps:
            for line in maps:
                if "/wechat" in line and line.strip().endswith("/wechat"):
                    mapped = line.split()[-1]
                    break
    except OSError:
        mapped = None
    candidates = []
    if mapped:
        candidates.append(f"/proc/{pid}/root{mapped}")
        candidates.append(mapped)
    candidates.append(fallback)
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def elf_machine(path: str) -> int | None:
    try:
        with open(path, "rb") as fh:
            header = fh.read(20)
    except OSError:
        return None
    if header[:4] != b"\x7fELF" or len(header) < 20:
        return None
    return struct.unpack_from("<H", header, 18)[0]


def arch_name(machine: int | None) -> str | None:
    if machine == ELF_EM_AARCH64:
        return "aarch64"
    if machine == ELF_EM_X86_64:
        return "x86_64"
    return None


def read_build_id(path: str) -> str | None:
    try:
        result = subprocess.run(
            ["readelf", "-n", path],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    for line in result.stdout.splitlines():
        if "Build ID:" in line:
            return line.split("Build ID:", 1)[1].strip()
    return None


def tool_present(name: str) -> bool:
    if os.path.isfile(name) and os.access(name, os.X_OK):
        return True
    return shutil.which(name) is not None


def repo_tool_path(*parts: str) -> str | None:
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.normpath(os.path.join(here, "..", "..", *parts))
    return candidate if os.path.isfile(candidate) else None


def resolve_tool(*candidates: str) -> str | None:
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def iter_maps(pid: int, perms_substr: str | None = None):
    with open(f"/proc/{pid}/maps", encoding="utf-8") as maps:
        for line in maps:
            parts = line.split()
            if len(parts) < 5:
                continue
            if perms_substr and perms_substr not in parts[1]:
                continue
            start_s, end_s = parts[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            pathname = parts[-1] if len(parts) >= 6 else ""
            yield start, end, parts[1], pathname


class ProcMem:
    def __init__(self, pid: int):
        self.pid = pid
        self._fh = open(f"/proc/{pid}/mem", "rb")

    def close(self) -> None:
        self._fh.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def read(self, addr: int, size: int) -> bytes:
        self._fh.seek(addr)
        data = self._fh.read(size)
        if len(data) != size:
            raise OSError(f"short read at {addr:#x}")
        return data

    def read_u64(self, addr: int) -> int:
        return struct.unpack("<Q", self.read(addr, 8))[0]


class ByteMem:
    """In-memory stand-in for ProcMem, used by unit tests."""

    def __init__(self, blob: bytearray, base: int = 0):
        self.blob = blob
        self.base = base

    def read(self, addr: int, size: int) -> bytes:
        off = addr - self.base
        if off < 0 or off + size > len(self.blob):
            raise OSError(f"out of range read at {addr:#x}")
        return bytes(self.blob[off:off + size])

    def read_u64(self, addr: int) -> int:
        return struct.unpack("<Q", self.read(addr, 8))[0]


def read_std_string(mem, addr: int, max_len: int = 512) -> str | None:
    """Read a libstdc++ SSO std::string. Returns None on failure."""
    try:
        head = mem.read(addr, 24)
    except OSError:
        return None
    b0 = head[0]
    try:
        if b0 & 1:
            length = struct.unpack_from("<Q", head, 8)[0]
            ptr = struct.unpack_from("<Q", head, 16)[0]
            if length <= 0 or length > max_len or ptr < 0x10000:
                return None
            raw = mem.read(ptr, length)
            return raw.decode("utf-8")
        length = b0 >> 1
        if length <= 0 or length > 22:
            return None
        return head[1:1 + length].decode("utf-8")
    except (OSError, UnicodeDecodeError, struct.error):
        return None


def plausible_ptr(value: int) -> bool:
    return 0x10000 <= value <= 0x0000FFFFFFFFFFFF


def load_aes_key(env_name: str = "WECHAT_IMAGE_AES", path: str | None = None) -> bytes:
    """Load a 32-char ASCII hex image key without logging it."""
    raw = None
    if path:
        st = os.stat(path)
        if st.st_mode & 0o077:
            raise PermissionError("AES key file must be root-only (mode 0600 or stricter)")
        with open(path, "rb") as fh:
            raw = fh.read().strip()
    elif os.environ.get(env_name):
        raw = os.environ[env_name].strip().encode("ascii")
    if not raw:
        raise ValueError("missing 32-char image AES key (env or --aes-file)")
    if len(raw) != 32 or any(c not in b"0123456789abcdef" for c in raw):
        raise ValueError("image AES key must be 32 lowercase hex ASCII chars")
    return raw


def parse_elf_loads(elf: bytes):
    if elf[:4] != b"\x7fELF" or elf[4] != 2:
        raise ValueError("ELF64 required")
    e_phoff = struct.unpack_from("<Q", elf, 32)[0]
    e_phentsize = struct.unpack_from("<H", elf, 54)[0]
    e_phnum = struct.unpack_from("<H", elf, 56)[0]
    loads = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, p_flags = struct.unpack_from("<II", elf, off)
        p_offset, p_vaddr, _, p_filesz, p_memsz, _ = struct.unpack_from("<QQQQQQ", elf, off + 8)
        if p_type == 1:
            loads.append({
                "offset": p_offset,
                "vaddr": p_vaddr,
                "filesz": p_filesz,
                "memsz": p_memsz,
                "flags": p_flags,
                "exec": bool(p_flags & 1),
            })
    return loads
