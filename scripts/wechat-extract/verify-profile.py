#!/usr/bin/env python3
"""Verify a committed build profile: image extract + chat-select --list/filehelper.

Never prints account keys. Reports presence flags and counts only.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    emit_json,
    find_wechat_pid,
    repo_tool_path,
    resolve_tool,
)


def load_py(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify committed WeChat build profile")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--extract-keys", default=None)
    parser.add_argument("--chat-select", default=None)
    parser.add_argument("--home", default="/home/wechat")
    parser.add_argument("--skip-select", action="store_true")
    args = parser.parse_args()
    os.environ.setdefault("HOME", args.home)

    extract_path = resolve_tool(
        args.extract_keys,
        "/opt/tools/extract-keys.py",
        repo_tool_path("docker", "tools", "extract-keys.py"),
    )
    chat_path = resolve_tool(
        args.chat_select,
        "/opt/tools/chat-select.py",
        repo_tool_path("docker", "tools", "chat-select.py"),
        "/opt/tools/chat-select",
    )
    if not extract_path or not chat_path:
        emit_json({"error": "tools_missing"}, ok=False)
        return 1

    pid = find_wechat_pid(args.pid)
    if not pid:
        emit_json({"error": "wechat_not_running"}, ok=False)
        return 1

    extract_keys = load_py(extract_path, "extract_keys")
    chat_select = load_py(chat_path if chat_path.endswith(".py") else chat_path, "chat_select")

    build_id = extract_keys.get_build_id(pid)
    prefix = (build_id or "")[:8]
    image_profile = extract_keys.BUILD_PROFILES.get(prefix)
    chat_profile = chat_select.profile_for_build_id(build_id) if build_id else None

    image_ok = False
    image_error = None
    if image_profile is not None:
        try:
            key = extract_keys.extract_image_aes_key(pid, image_profile)
            image_ok = isinstance(key, str) and len(key) == 32
        except Exception as exc:
            image_error = type(exc).__name__
    else:
        image_error = "missing_image_profile"

    list_ok = False
    has_filehelper = False
    session_count = 0
    select_ok = False
    chat_error = None
    if chat_profile is None:
        chat_error = "missing_chat_profile"
    else:
        try:
            sessions, _, _, _ = chat_select.enumerate_sessions(str(pid), chat_profile)
            session_count = len(sessions)
            has_filehelper = "filehelper" in sessions
            list_ok = has_filehelper
        except Exception as exc:
            chat_error = type(exc).__name__
        if list_ok and not args.skip_select:
            cmd = [sys.executable, chat_path, "filehelper"] if chat_path.endswith(".py") else [chat_path, "filehelper"]
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
                payload = json.loads(result.stdout.strip().splitlines()[-1])
                select_ok = bool(payload.get("ok")) and payload.get("verified") is True
            except Exception as exc:
                chat_error = chat_error or type(exc).__name__

    ok = image_ok and list_ok and (args.skip_select or select_ok)
    emit_json({
        "pid": pid,
        "buildPrefix": prefix or None,
        "imageProfile": image_profile is not None,
        "chatProfile": chat_profile is not None,
        "imageExtractOk": image_ok,
        "imageError": image_error,
        "listOk": list_ok,
        "hasFilehelper": has_filehelper,
        "sessionCount": session_count,
        "selectFilehelperOk": select_ok,
        "chatError": chat_error,
    }, ok=ok)
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
