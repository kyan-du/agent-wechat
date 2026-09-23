#!/usr/bin/env python3
"""Behavior tests for WeChat process identity selection. No live WeChat."""
from __future__ import annotations

import os
import tempfile
import unittest

from wechat_proc import find_wechat_pid, is_wechat_main_process, select_wechat_pid


def write(path: str, data: bytes | str) -> None:
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(path, mode) as fh:
        fh.write(data)


def proc(root: str, pid: int, *, comm: str, exe: str | None = None, argv0: str | None = None,
         state: str = "S", db_storage: bool = False, fd_target: str | None = None) -> None:
    base = os.path.join(root, str(pid))
    os.makedirs(os.path.join(base, "fd"), exist_ok=True)
    write(os.path.join(base, "comm"), comm + "\n")
    write(os.path.join(base, "status"), f"Name:\t{comm}\nState:\t{state} (sleeping)\n")
    if argv0 is not None:
        write(os.path.join(base, "cmdline"), argv0.encode() + b"\0--annotation=ignored\0")
    if exe is not None:
        os.symlink(exe, os.path.join(base, "exe"))
    if db_storage:
        target = fd_target or "/home/wechat/xwechat_files/wxid/db_storage/session/session.db"
        os.symlink(target, os.path.join(base, "fd", "3"))


class WeChatProcTests(unittest.TestCase):
    def test_path_annotation_containing_wechat_does_not_make_crashpad_main(self):
        view = {
            "pid": 10,
            "comm": "chrome_crashpad_handler",
            "exe": "/opt/wechat/chrome_crashpad_handler",
            "argv0": "/opt/wechat/wechat --annotation=/opt/wechat/wechat",
            "state": "S",
            "has_db_storage": True,
        }
        self.assertFalse(is_wechat_main_process(view))

    def test_selects_real_wechat_over_crashpad_with_more_fds_or_annotations(self):
        views = [
            {
                "pid": 10,
                "comm": "chrome_crashpad_handler",
                "exe": "/opt/wechat/chrome_crashpad_handler",
                "argv0": "/opt/wechat/wechat --database=/opt/wechat/wechat",
                "state": "S",
                "has_db_storage": True,
            },
            {
                "pid": 20,
                "comm": "wechat",
                "exe": "/opt/wechat/wechat",
                "argv0": "/opt/wechat/wechat",
                "state": "S",
                "has_db_storage": False,
            },
        ]
        self.assertEqual(select_wechat_pid(views), 20)

    def test_prefers_db_storage_then_known_path_then_lowest_pid(self):
        views = [
            {"pid": 30, "comm": "wechat", "exe": "/tmp/wechat", "argv0": "/tmp/wechat", "state": "S", "has_db_storage": True},
            {"pid": 20, "comm": "wechat", "exe": "/opt/wechat/wechat", "argv0": "/opt/wechat/wechat", "state": "S", "has_db_storage": False},
            {"pid": 10, "comm": "wechat", "exe": "/usr/bin/wechat", "argv0": "/usr/bin/wechat", "state": "S", "has_db_storage": False},
        ]
        self.assertEqual(select_wechat_pid(views), 30)
        views[0]["has_db_storage"] = False
        self.assertEqual(select_wechat_pid(views), 20)

    def test_returns_none_when_no_live_main_candidate(self):
        views = [
            {"pid": 10, "comm": "wechat", "exe": "/opt/wechat/wechat", "argv0": "/opt/wechat/wechat", "state": "Z", "has_db_storage": True},
            {"pid": 11, "comm": "chrome_crashpad_handler", "exe": "/opt/wechat/wechat", "argv0": "/opt/wechat/wechat", "state": "S", "has_db_storage": True},
        ]
        self.assertIsNone(select_wechat_pid(views))

    def test_find_wechat_pid_scans_proc_fixture_and_validates_explicit_pid(self):
        with tempfile.TemporaryDirectory() as root:
            proc(root, 10, comm="chrome_crashpad_handler", exe="/opt/wechat/chrome_crashpad_handler", argv0="/opt/wechat/wechat", db_storage=True)
            proc(root, 20, comm="wechat", exe="/opt/wechat/wechat", argv0="/opt/wechat/wechat")
            proc(root, 30, comm="wechat", exe="/usr/bin/wechat", argv0="/usr/bin/wechat", db_storage=True)
            self.assertEqual(find_wechat_pid(proc_root=root), 30)
            self.assertEqual(find_wechat_pid(explicit=20, proc_root=root), 20)
            self.assertEqual(find_wechat_pid(explicit=10, proc_root=root), 30)

    def test_dockerfile_copies_tools_dir_and_offline_kit_imports_helper(self):
        here = os.path.dirname(os.path.abspath(__file__))
        docker_dir = os.path.dirname(here)
        repo = os.path.dirname(docker_dir)
        with open(os.path.join(docker_dir, "Dockerfile"), encoding="utf-8") as fh:
            dockerfile = fh.read()
        self.assertIn("COPY tools/ /opt/tools/", dockerfile)
        self.assertTrue(os.path.isfile(os.path.join(here, "wechat_proc.py")))
        common_path = os.path.join(repo, "scripts", "wechat-extract", "common.py")
        with open(common_path, encoding="utf-8") as fh:
            common_src = fh.read()
        self.assertIn("from wechat_proc import find_wechat_pid", common_src)
        self.assertIn('parents[2] / "docker" / "tools"', common_src)


if __name__ == "__main__":
    unittest.main()
