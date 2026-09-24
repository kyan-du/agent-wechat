#!/usr/bin/env python3
"""Dump WeChat PID, arch, BuildID, and binary path. Never prints secrets."""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    arch_name,
    elf_machine,
    emit_json,
    find_wechat_path,
    find_wechat_pid,
    read_build_id,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump WeChat BuildID and arch")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--binary", default="/opt/wechat/wechat")
    args = parser.parse_args()

    pid = find_wechat_pid(args.pid)
    path = find_wechat_path(pid, args.binary) if pid else (
        args.binary if os.path.isfile(args.binary) else None
    )
    if not path:
        emit_json({"error": "wechat_binary_not_found"}, ok=False)
        return 1

    machine = elf_machine(path)
    arch = arch_name(machine)
    build_id = read_build_id(path)
    payload = {
        "pid": pid,
        "arch": arch,
        "buildId": build_id,
        "buildPrefix": build_id[:8] if build_id else None,
        "path": path,
        "elfMachine": machine,
    }
    emit_json(payload, ok=bool(build_id and arch))
    return 0 if build_id and arch else 1


if __name__ == "__main__":
    sys.exit(main())
