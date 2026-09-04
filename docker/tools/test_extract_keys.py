#!/usr/bin/env python3
import importlib.util
import io
import os
import unittest
from contextlib import redirect_stdout
from unittest import mock

MODULE_PATH = os.path.join(os.path.dirname(__file__), "extract-keys.py")
spec = importlib.util.spec_from_file_location("extract_keys", MODULE_PATH)
extract_keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract_keys)


def _ascii_key(seed):
    """Build a deterministic 32-char hex key with >= 8 distinct chars."""
    hexchars = "0123456789abcdef"
    return "".join(hexchars[(seed + i) % 16] for i in range(32))


class BuildProfilesTest(unittest.TestCase):
    def test_all_masks_are_32_bytes(self):
        self.assertTrue(extract_keys.BUILD_PROFILES)
        for prefix, profile in extract_keys.BUILD_PROFILES.items():
            mask = profile["image_xor_mask"]
            self.assertEqual(len(mask), 32, f"{prefix} mask must be 32 bytes")

    def test_v4118_build_present(self):
        # WeChat Linux v4.1.1.8 aarch64 (regression guard for issue #119).
        self.assertIn("9a3558be", extract_keys.BUILD_PROFILES)


class GetBuildProfileTest(unittest.TestCase):
    def test_known_build_returns_profile(self):
        with mock.patch.object(extract_keys, "get_build_id",
                               return_value="9a3558be209dfcf1b85d6ec18bf029c7f97ccb61"):
            with redirect_stdout(io.StringIO()):
                profile = extract_keys.get_build_profile(pid=1234)
        self.assertIs(profile, extract_keys.BUILD_PROFILES["9a3558be"])

    def test_unknown_build_returns_none(self):
        # Must NOT silently fall back to another build's mask (issue #119).
        with mock.patch.object(extract_keys, "get_build_id",
                               return_value="deadbeef" + "0" * 32):
            with redirect_stdout(io.StringIO()) as out:
                profile = extract_keys.get_build_profile(pid=1234)
        self.assertIsNone(profile)
        self.assertIn("unknown WeChat BuildID", out.getvalue())

    def test_missing_build_id_returns_none(self):
        with mock.patch.object(extract_keys, "get_build_id", return_value=None):
            with redirect_stdout(io.StringIO()):
                profile = extract_keys.get_build_profile(pid=1234)
        self.assertIsNone(profile)


class ScanBufferTest(unittest.TestCase):
    def test_roundtrip_recovers_key(self):
        # Synthetic mask/key only. Real account keys are never committed; the
        # mask is a build constant and lives in BUILD_PROFILES.
        mask = bytes((i * 7 + 3) & 0xFF for i in range(32))
        key = _ascii_key(seed=1)
        obf = bytes(ord(key[i]) ^ mask[i] for i in range(32))
        buffer = b"\x00" * 100 + obf + b"\xff" * 100
        self.assertEqual(extract_keys.scan_buffer_for_image_key(buffer, mask), key)

    def test_no_key_returns_none(self):
        mask = bytes((i * 7 + 3) & 0xFF for i in range(32))
        self.assertIsNone(
            extract_keys.scan_buffer_for_image_key(b"\x00" * 1000, mask))

    def test_wrong_mask_does_not_recover_key(self):
        mask = bytes((i * 7 + 3) & 0xFF for i in range(32))
        key = _ascii_key(seed=5)
        obf = bytes(ord(key[i]) ^ mask[i] for i in range(32))
        buffer = b"\x11" * 50 + obf + b"\x22" * 50
        wrong = bytes((b + 1) & 0xFF for b in mask)
        self.assertNotEqual(
            extract_keys.scan_buffer_for_image_key(buffer, wrong), key)


class ExtractImageKeysGuardTest(unittest.TestCase):
    def test_none_profile_raises(self):
        with self.assertRaises(RuntimeError):
            extract_keys.extract_image_keys(pid=1234, profile=None)


if __name__ == "__main__":
    unittest.main()
