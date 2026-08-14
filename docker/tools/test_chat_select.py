#!/usr/bin/env python3
import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

MODULE_PATH = os.path.join(os.path.dirname(__file__), "chat-select.py")
spec = importlib.util.spec_from_file_location("chat_select", MODULE_PATH)
chat_select = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chat_select)


class FakeStdout:
    def fileno(self):
        return 0


class FakeProcess:
    def __init__(self):
        self.stdout = FakeStdout()
        self.stdin = mock.Mock()

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


class ChatSelectDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        chat_select._DIAGNOSTICS.update(used_frida=False, frida_attach_count=0)

    def test_result_is_redacted_and_machine_readable(self):
        stream = io.StringIO()
        with self.assertRaises(SystemExit), redirect_stdout(stream):
            chat_select.fail("TARGET_NOT_FOUND", "Target was not found")
        result = json.loads(stream.getvalue())
        self.assertEqual(result["errorCode"], "TARGET_NOT_FOUND")
        self.assertEqual(result["usedFrida"], False)
        self.assertEqual(result["fridaAttachCount"], 0)
        serialized = json.dumps(result)
        for secret in ("message text", "/tmp/private", "Bearer token", "data:image/png;base64"):
            self.assertNotIn(secret, serialized)

    @mock.patch.object(chat_select.time, "sleep")
    @mock.patch.object(chat_select, "read_lines_until", return_value=[])
    @mock.patch.object(chat_select.subprocess, "Popen", return_value=FakeProcess())
    def test_silent_frida_attach_times_out_fail_closed(self, _popen, _read, _sleep):
        with self.assertRaises(chat_select.FridaError) as caught:
            chat_select.run_frida_script("123", "/tmp/script.js", timeout=0.01)
        self.assertEqual(caught.exception.code, "FRIDA_ATTACH_TIMEOUT")
        self.assertTrue(chat_select._DIAGNOSTICS["used_frida"])
        self.assertEqual(chat_select._DIAGNOSTICS["frida_attach_count"], 1)

    @mock.patch.object(
        chat_select.subprocess,
        "Popen",
        side_effect=OSError("/private/path/frida token=secret"),
    )
    def test_frida_spawn_failure_does_not_expose_detail(self, _popen):
        with self.assertRaises(chat_select.FridaError) as caught:
            chat_select.run_frida_script("123", "/tmp/private.js")
        self.assertEqual(caught.exception.code, "FRIDA_ATTACH_FAILED")
        self.assertEqual(str(caught.exception), "Frida could not start")
        self.assertNotIn("private", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))

    @mock.patch.object(chat_select, "get_pid", return_value="123")
    @mock.patch.object(chat_select, "get_profile", return_value=({"ARCH": "x86_64"}, None))
    @mock.patch.object(
        chat_select,
        "enumerate_sessions",
        side_effect=chat_select.FridaError("FRIDA_ATTACH_TIMEOUT", "Frida attach timed out"),
    )
    def test_main_exposes_timeout_code_without_identity(
        self, _enumerate, _profile, _pid
    ):
        stream = io.StringIO()
        with mock.patch.object(sys, "argv", ["chat-select", "private-wxid"]):
            with self.assertRaises(SystemExit), redirect_stdout(stream):
                chat_select.main()
        result = json.loads(stream.getvalue())
        self.assertEqual(result["errorCode"], "FRIDA_ATTACH_TIMEOUT")
        self.assertFalse(result["ok"])
        serialized = json.dumps(result)
        self.assertNotIn("Sensitive Name", serialized)
        self.assertNotIn("private-wxid", serialized)


if __name__ == "__main__":
    unittest.main()
