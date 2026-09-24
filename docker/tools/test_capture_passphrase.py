#!/usr/bin/env python3
"""Unit tests for production passphrase capture. No live WeChat, no secrets."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "capture_passphrase", os.path.join(HERE, "capture-passphrase.py")
)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CapturePassphraseTests(unittest.TestCase):
    def test_known_build_hooks_cover_both_arches(self):
        arm = capture.hooks_for_build("e9f1cd04", None)
        amd = capture.hooks_for_build("ce28c347", None)
        self.assertEqual(arm[0][0], "cipher_config")
        self.assertEqual(amd[0][0], "cipher_config")
        self.assertNotEqual(arm[0][1], amd[0][1])

    def test_unknown_build_requires_explicit_hooks(self):
        with self.assertRaises(ValueError):
            capture.hooks_for_build("deadbeef", None)
        hooks = capture.hooks_for_build("deadbeef", "cipher_config:0x11")
        self.assertEqual(hooks, [("cipher_config", 0x11)])

    def test_render_script_injects_offsets(self):
        src = capture.render_script([("cipher_config", 0x87AC370)])
        self.assertIn('name: "cipher_config"', src)
        self.assertIn('off: "0x87ac370"', src)
        self.assertIn("args[1]", src)
        self.assertNotIn("{{HOOKS}}", src)

    def test_print_hooks_json_marks_rvas_as_arch_specific(self):
        stream = io.StringIO()
        argv = [
            "capture-passphrase.py",
            "--print-hooks",
            "--build-prefix", "ce28c347",
        ]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(stream):
            rc = capture.main()
        self.assertEqual(rc, 0)
        payload = json.loads(stream.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["hooks"][0]["name"], "cipher_config")
        self.assertEqual(payload["transfer"]["dataObject"], "size@+16 ptr@+8")

    def test_mark_hooks_ready_creates_sibling_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "wechat-passphrase.bin")
            capture.mark_hooks_ready(path)
            ready = path + ".ready"
            st = os.stat(ready)
            self.assertEqual(st.st_mode & 0o777, 0o600)

    def test_save_passphrase_is_mode_0600(self):
        blob = bytes(range(32))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "wechat-passphrase.bin")
            capture.save_passphrase(path, blob)
            st = os.stat(path)
            self.assertEqual(st.st_mode & 0o777, 0o600)
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), blob)

    def test_classify_blob_accepts_passphrase_via_hmac64(self):
        passphrase = bytes((i * 3) & 0xFF for i in range(32))
        salt = bytes((i * 5) & 0xFF for i in range(16))
        enc = capture.hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=32)
        page1 = bytearray(4096)
        page1[:16] = salt
        mac_salt = bytes(b ^ 0x3A for b in salt)
        mac_key = capture.hashlib.pbkdf2_hmac("sha512", enc, mac_salt, 2, dklen=32)
        hmac_data = bytes(page1[16:4096 - 80 + 16])
        digest = capture.hmac.new(mac_key, hmac_data, capture.hashlib.sha512)
        digest.update(struct.pack("<I", 1))
        page1[4096 - 64:] = digest.digest()
        self.assertEqual(capture.classify_blob(passphrase, bytes(page1)), "passphrase")
        self.assertIsNone(capture.classify_blob(b"\x00" * 32, bytes(page1)))

    def test_wrapper_forces_wechat_home(self):
        wrapper = os.path.join(HERE, "capture-passphrase")
        with open(wrapper, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("HOME=/home/wechat", src)
        self.assertIn("capture-passphrase.py", src)


if __name__ == "__main__":
    unittest.main()
