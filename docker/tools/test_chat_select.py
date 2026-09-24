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
        self.terminated = False
        self.killed = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True


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

    @mock.patch.object(chat_select, "read_lines_until", side_effect=OSError("SUPER_SECRET reader"))
    @mock.patch.object(chat_select.subprocess, "Popen")
    def test_background_readiness_error_always_detaches(self, popen, _read):
        proc = FakeProcess()
        popen.return_value = proc
        with self.assertRaises(chat_select.FridaError) as caught:
            chat_select.run_frida_bg("123", "/tmp/private.js")
        self.assertEqual(caught.exception.code, "FRIDA_ATTACH_FAILED")
        self.assertEqual(str(caught.exception), "Frida readiness check failed")
        self.assertTrue(proc.terminated)
        self.assertNotIn("SECRET", str(caught.exception))

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
        self.assertNotIn("private-wxid", json.dumps(result))

    def test_click_timeout_always_detaches_background_hook(self):
        proc = FakeProcess()
        profile = {"SELECT_SESSION": 1, "USERNAME_OFF": 2, "ELEM_SIZE": 16, "ARCH": "x86_64"}
        with mock.patch.object(chat_select, "run_frida_bg", return_value=proc):
            with mock.patch.object(
                chat_select.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["click"], 5),
            ):
                with self.assertRaises(chat_select.FridaError) as caught:
                    chat_select.select_by_index("123", profile, 0, (1, 2), "0x1000", 1)
        self.assertEqual(caught.exception.code, "CHAT_CLICK_TIMEOUT")
        self.assertTrue(proc.terminated)

    def test_click_spawn_failure_always_detaches_background_hook(self):
        proc = FakeProcess()
        profile = {"SELECT_SESSION": 1, "USERNAME_OFF": 2, "ELEM_SIZE": 16, "ARCH": "x86_64"}
        with mock.patch.object(chat_select, "run_frida_bg", return_value=proc):
            with mock.patch.object(
                chat_select.subprocess,
                "run",
                side_effect=OSError("SUPER_SECRET /private/tool"),
            ):
                with self.assertRaises(chat_select.FridaError) as caught:
                    chat_select.select_by_index("123", profile, 0, (1, 2), "0x1000", 1)
        self.assertEqual(caught.exception.code, "CHAT_CLICK_FAILED")
        self.assertTrue(proc.terminated)
        self.assertNotIn("SECRET", str(caught.exception))

    def test_malformed_click_coordinates_return_redacted_json_without_traceback(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = ["chat-select", "--click-xy", "SUPER_SECRET", "1", "private-wxid"]
        with mock.patch.object(sys, "argv", argv):
            with self.assertRaises(SystemExit), redirect_stdout(stdout), mock.patch("sys.stderr", stderr):
                chat_select.main()
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["errorCode"], "INVALID_ARGUMENT")
        self.assertNotIn("SUPER_SECRET", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_current_pinned_arm64_build_has_exact_profile(self):
        profile = chat_select.profile_for_build_id(
            "9a3558be209dfcf1b85d6ec18bf029c7f97ccb61"
        )
        self.assertIsNotNone(profile)
        self.assertEqual(profile["ARCH"], "aarch64")
        self.assertEqual(profile["SELECT_SESSION"], 0x3939FF8)
        self.assertEqual(profile["MANAGER_VT_OFF"], 0x7DB5570)

    def test_unknown_build_still_has_no_profile(self):
        self.assertIsNone(chat_select.profile_for_build_id("00000000deadbeef"))

    def test_wechat_binary_path_prefers_pid_root(self):
        with mock.patch("builtins.open", mock.mock_open(
            read_data="aaaad49f0000-aaaad49f1000 r-xp 00000000 00:00 0 /opt/wechat/wechat\n"
        )), mock.patch.object(os.path, "isfile", side_effect=lambda p: p.endswith("/proc/22/root/opt/wechat/wechat")):
            self.assertEqual(
                chat_select.wechat_binary_path(22),
                "/proc/22/root/opt/wechat/wechat",
            )

    def test_v411323_arm64_build_has_shifted_layout(self):
        profile = chat_select.profile_for_build_id(
            "e9f1cd045de714536a9e739aafa6d8362f317cd0"
        )
        self.assertIsNotNone(profile)
        self.assertEqual(profile["ARCH"], "aarch64")
        self.assertEqual(profile["SELECT_SESSION"], 0x48543D0)
        self.assertEqual(profile["MANAGER_VT_OFF"], 0x9FE8CC8)
        self.assertEqual(profile["USERNAME_OFF"], 0x130)
        self.assertEqual(profile["CTRL_OFF"], 0xE8)
        self.assertEqual(profile["VEC_KEY_OFF"], 0x168)
        self.assertEqual(profile["CUR_SESS_UNAME_OFF"], 0x130)

    def test_v411323_amd64_build_has_flattened_layout(self):
        profile = chat_select.profile_for_build_id(
            "ce28c3471d532eeb1f136482eeb4d0bdfd59c06e"
        )
        self.assertIsNotNone(profile)
        self.assertEqual(profile["ARCH"], "x86_64")
        self.assertEqual(profile["SELECT_SESSION"], 0x85DAFD0)
        self.assertEqual(profile["MANAGER_VT_OFF"], 0xA6A95C8)
        self.assertEqual(profile["USERNAME_OFF"], 0x130)
        self.assertEqual(profile["CTRL_OFF"], 0xE8)
        self.assertEqual(profile["VEC_KEY_OFF"], 0x168)
        self.assertNotIn("VEC_MAP_OFF", profile)

    def test_frida_command_bootstraps_typing_extensions_on_python310(self):
        cmd = chat_select.frida_command("123", "/tmp/script.js", quiet=True)
        self.assertEqual(cmd[:3], [sys.executable, "-c", chat_select.FRIDA_PYTHON_BOOTSTRAP])
        self.assertIn("typing_extensions", cmd[2])
        self.assertEqual(cmd[-1], "-q")

    def test_select_hook_rewrites_x23_and_delays_detach(self):
        with open(MODULE_PATH, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("this.context.x23 = TARGET", src)
        self.assertIn("setTimeout(function() {{", src)
        self.assertIn("}}, 2500);", src)

    def test_current_sel_falls_back_to_index_when_pointer_null(self):
        with open(MODULE_PATH, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("ctrl.add(0x30).readU64()", src)
        self.assertIn("filtered index nearby", src)

    def test_filtered_index_skips_official_accounts(self):
        raw = [
            (0, "filehelper"),
            (1, "gh_abc123"),
            (2, "wxid_user"),
            (3, "123@chatroom"),
        ]
        sessions = chat_select.filtered_session_index(raw)
        self.assertEqual(sessions, {
            "filehelper": 0,
            "wxid_user": 1,
            "123@chatroom": 2,
        })
        self.assertNotIn("gh_abc123", sessions)

    @mock.patch.object(chat_select, "get_pid", return_value="123")
    @mock.patch.object(chat_select, "get_profile", return_value=({"ARCH": "x86_64"}, None))
    @mock.patch.object(
        chat_select,
        "enumerate_sessions",
        return_value=({"filehelper": 0, "wxid_user": 1}, "0x1000", 3, "wxid_user"),
    )
    def test_official_account_target_is_rejected(self, _enumerate, _profile, _pid):
        stream = io.StringIO()
        with mock.patch.object(sys, "argv", ["chat-select", "gh_abc123"]):
            with self.assertRaises(SystemExit), redirect_stdout(stream):
                chat_select.main()
        result = json.loads(stream.getvalue())
        self.assertEqual(result["errorCode"], "OFFICIAL_ACCOUNT_UNSUPPORTED")
        self.assertFalse(result["ok"])
        self.assertNotIn("gh_abc123", json.dumps(result))

    def test_already_selected_short_circuit_is_the_only_skipped_path(self):
        with open(MODULE_PATH, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("skipped=True, verified=True", src)
        self.assertIn("Exact target already selected", src)
        self.assertIn("skipped=False, verified=True", src)
        self.assertIn("Target confirmation failed after selection", src)

    def test_old_and_new_profiles_keep_distinct_offsets(self):
        old = chat_select.profile_for_build_id(
            "9a3558be209dfcf1b85d6ec18bf029c7f97ccb61"
        )
        new_arm = chat_select.profile_for_build_id(
            "e9f1cd045de714536a9e739aafa6d8362f317cd0"
        )
        new_amd = chat_select.profile_for_build_id(
            "ce28c3471d532eeb1f136482eeb4d0bdfd59c06e"
        )
        self.assertNotEqual(old["SELECT_SESSION"], new_arm["SELECT_SESSION"])
        self.assertNotEqual(old["USERNAME_OFF"], new_arm["USERNAME_OFF"])
        self.assertEqual(new_arm["USERNAME_OFF"], new_amd["USERNAME_OFF"])
        self.assertEqual(new_arm["CTRL_OFF"], new_amd["CTRL_OFF"])
        self.assertNotIn("VEC_MAP_OFF", new_arm)
        self.assertNotIn("VEC_MAP_OFF", new_amd)



class ChatSelectUiScanTests(unittest.TestCase):
    def test_valid_bounds_rejects_empty(self):
        self.assertFalse(chat_select._valid_bounds(None))
        self.assertFalse(chat_select._valid_bounds({"x": 0, "y": 0, "width": 0, "height": 10}))
        self.assertTrue(chat_select._valid_bounds({"x": 1, "y": 2, "width": 10, "height": 10}))

    def test_find_chat_list_items_returns_all_rows_in_order(self):
        tree = {
            "role": "desktop-frame",
            "children": [{
                "role": "list",
                "name": "Chats",
                "children": [
                    {"role": "list-item", "name": "A", "bounds": {"x": 0, "y": 0, "width": 10, "height": 10}},
                    {"role": "list-item", "name": "B", "bounds": {"x": 0, "y": 10, "width": 10, "height": 10}},
                    {"role": "list-item", "name": "bad", "bounds": {"x": 0, "y": 20, "width": 0, "height": 10}},
                ],
            }],
        }
        items = []
        chat_select._find_chat_list_items(tree, items, False)
        self.assertEqual([i["name"] for i in items], ["A", "B"])

    def test_activate_picks_largest_weixin_window(self):
        geoms = {
            "1": "Window 1\n  Position: 0,0\n  Geometry: 100x100\n",
            "2": "Window 2\n  Position: 0,0\n  Geometry: 880x640\n",
        }
        calls = []
        def fake_output(cmd, text=True, timeout=5, stderr=None):
            if cmd[:2] == ["xdotool", "search"]:
                return "1\n2\n"
            if cmd[:2] == ["xdotool", "getwindowgeometry"]:
                return geoms[cmd[2]]
            raise AssertionError(cmd)
        def fake_run(cmd, timeout=5, check=False, capture_output=True):
            calls.append(cmd)
            return mock.Mock(returncode=0)
        with mock.patch.object(chat_select.subprocess, "check_output", side_effect=fake_output), \
             mock.patch.object(chat_select.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(chat_select.time, "sleep"):
            self.assertTrue(chat_select.activate_main_wechat_window())
        self.assertEqual(calls[0][:3], ["xdotool", "windowactivate", "--sync"])
        self.assertEqual(calls[0][3], "2")

    def test_source_documents_ui_index_not_vector_index(self):
        with open(MODULE_PATH, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("select_target_by_ui_scan", src)
        self.assertIn("visible UI list", src)
        self.assertIn("activate_main_wechat_window", src)


if __name__ == "__main__":
    unittest.main()
