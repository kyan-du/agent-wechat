#!/usr/bin/env python3
"""Identify the WeChat main process from /proc identity, not cmdline substrings.

Never log cmdline, keys, or annotation values.
"""
from __future__ import annotations

import os
from typing import Iterable

WECHAT_COMM = "wechat"
CRASHPAD_TOKEN = "crashpad"
OPT_WECHAT = "/opt/wechat/wechat"
USR_WECHAT = "/usr/bin/wechat"


def _basename(path: str | None) -> str:
    if not path:
        return ""
    return os.path.basename(path.rstrip("/"))


def _read_bytes(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def inspect_wechat_process(pid: int, proc_root: str = "/proc") -> dict | None:
    """Read comm/exe/argv0/state for a PID. None if the process has exited."""
    if pid <= 0:
        return None
    base = os.path.join(proc_root, str(pid))
    comm_raw = _read_bytes(os.path.join(base, "comm"))
    if comm_raw is None:
        return None
    comm = comm_raw.decode("utf-8", "replace").split("\0", 1)[0].strip()
    if not comm:
        return None

    state = None
    status_raw = _read_bytes(os.path.join(base, "status"))
    if status_raw is not None:
        status = status_raw.decode("utf-8", "replace")
        for line in status.splitlines():
            if line.startswith("State:"):
                rest = line.split(":", 1)[1].strip()
                state = rest[:1] if rest else None
                break

    exe = None
    try:
        exe = os.readlink(os.path.join(base, "exe"))
    except OSError:
        exe = None

    argv0 = None
    cmdline_raw = _read_bytes(os.path.join(base, "cmdline"))
    if cmdline_raw:
        first = cmdline_raw.split(b"\0", 1)[0]
        if first:
            argv0 = first.decode("utf-8", "replace")

    has_db_storage = False
    fd_dir = os.path.join(base, "fd")
    try:
        for name in os.listdir(fd_dir):
            try:
                target = os.readlink(os.path.join(fd_dir, name))
            except OSError:
                continue
            if "db_storage" in target and target.endswith(".db"):
                has_db_storage = True
                break
    except OSError:
        pass

    return {
        "pid": int(pid),
        "comm": comm,
        "exe": exe,
        "argv0": argv0,
        "state": state,
        "has_db_storage": has_db_storage,
    }


def is_wechat_main_process(view: dict | None) -> bool:
    """True only for a live WeChat main process, never crashpad helpers."""
    if not view:
        return False
    if view.get("state") == "Z":
        return False
    comm = (view.get("comm") or "").strip()
    exe = view.get("exe") or ""
    argv0 = view.get("argv0") or ""
    identity = f"{comm}\n{exe}\n{argv0}".lower()
    if CRASHPAD_TOKEN in identity:
        return False
    if comm != WECHAT_COMM:
        return False
    return _basename(exe) == WECHAT_COMM or _basename(argv0) == WECHAT_COMM


def _path_rank(exe: str | None) -> int:
    if exe == OPT_WECHAT:
        return 0
    if exe == USR_WECHAT:
        return 1
    if _basename(exe) == WECHAT_COMM:
        return 2
    return 3


def select_wechat_pid(views: Iterable[dict | None]) -> int | None:
    """Pick the WeChat main PID from inspected views.

    Does not use pgrep order or open-fd counts. Prefers a process with a
    db_storage fd, then known WeChat binary paths, then the lowest PID.
    """
    mains = [view for view in views if is_wechat_main_process(view)]
    if not mains:
        return None
    mains.sort(
        key=lambda view: (
            not view.get("has_db_storage"),
            _path_rank(view.get("exe")),
            view["pid"],
        )
    )
    return mains[0]["pid"]


def iter_proc_pids(proc_root: str = "/proc") -> list[int]:
    try:
        names = os.listdir(proc_root)
    except OSError:
        return []
    pids = []
    for name in names:
        if name.isdigit():
            pid = int(name)
            if pid > 0:
                pids.append(pid)
    return pids


def find_wechat_pid(explicit: int | None = None, proc_root: str = "/proc") -> int | None:
    """Resolve the WeChat main PID.

    An explicit PID is used only when it still verifies as WeChat main.
    Otherwise scan proc_root. Unknown exe paths are allowed when comm and
    argv0/exe basename are wechat.
    """
    if explicit:
        view = inspect_wechat_process(explicit, proc_root)
        if is_wechat_main_process(view):
            return explicit
    views = [
        inspect_wechat_process(pid, proc_root) for pid in iter_proc_pids(proc_root)
    ]
    return select_wechat_pid(views)
