#!/usr/bin/env python3
import hashlib
import hmac
import importlib.util
import io
import json
import os
import struct
import tempfile
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

    def test_v411323_build_present(self):
        # WeChat Linux v4.1.13.23 aarch64.
        self.assertIn("e9f1cd04", extract_keys.BUILD_PROFILES)
        self.assertIn("ce28c347", extract_keys.BUILD_PROFILES)


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

    def test_wechat_binary_path_prefers_pid_root(self):
        with mock.patch("builtins.open", mock.mock_open(
            read_data="aaaad49f0000-aaaad49f1000 r-xp 00000000 00:00 0 /opt/wechat/wechat\n"
        )), mock.patch.object(os.path, "isfile", side_effect=lambda p: p.endswith("/proc/22/root/opt/wechat/wechat")):
            self.assertEqual(
                extract_keys.wechat_binary_path(22),
                "/proc/22/root/opt/wechat/wechat",
            )


class ScanBufferTest(unittest.TestCase):
    def test_v4118_committed_mask_roundtrip(self):
        # Uses the committed 9a3558be mask with a synthetic hex key only.
        # Proves scan_buffer_for_image_key agrees with the checked-in constant;
        # live PID memory + .dat decrypt still required to validate the constant.
        mask = extract_keys.BUILD_PROFILES["9a3558be"]["image_xor_mask"]
        key = _ascii_key(seed=9)
        obf = bytes(ord(key[i]) ^ mask[i] for i in range(32))
        buffer = b"\x00" * 64 + obf + b"\xff" * 64
        self.assertEqual(extract_keys.scan_buffer_for_image_key(buffer, mask), key)

    def test_v411323_committed_mask_roundtrip(self):
        mask = extract_keys.BUILD_PROFILES["e9f1cd04"]["image_xor_mask"]
        key = _ascii_key(seed=13)
        obf = bytes(ord(key[i]) ^ mask[i] for i in range(32))
        buffer = b"\x00" * 64 + obf + b"\xff" * 64
        self.assertEqual(extract_keys.scan_buffer_for_image_key(buffer, mask), key)

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


class MemChunkTest(unittest.TestCase):
    def test_iter_mem_chunks_splits_large_region(self):
        chunk = extract_keys._MEM_READ_CHUNK
        start, end = 0, chunk + chunk // 2
        chunks = list(extract_keys._iter_mem_chunks(start, end))
        self.assertEqual(chunks, [(0, chunk), (chunk, end)])


class KeySqlVariantsTest(unittest.TestCase):
    def test_matches_rust_cipher_compatibility_4(self):
        self.assertEqual(len(extract_keys._KEY_SQL_VARIANTS), 1)
        sql = extract_keys._KEY_SQL_VARIANTS[0]
        self.assertIn("cipher_compatibility = 4", sql)
        self.assertNotIn("HMAC_SHA1", sql)
        self.assertNotIn("cipher_compatibility = 3", sql)

    def test_keys_from_passphrase_stores_per_db_derived_raw_key(self):
        passphrase = bytes(range(32))
        salt_a = bytes(range(16))
        salt_b = bytes(range(16, 32))
        derived_a = extract_keys.derive_enc_key(passphrase, salt_a).hex()
        derived_b = extract_keys.derive_enc_key(passphrase, salt_b).hex()
        self.assertNotEqual(derived_a, derived_b)
        with tempfile.TemporaryDirectory() as tmp:
            contact = os.path.join(tmp, "contact.db")
            session = os.path.join(tmp, "session.db")
            with open(contact, "wb") as fh:
                fh.write(salt_a)
            with open(session, "wb") as fh:
                fh.write(salt_b)
            with mock.patch.object(extract_keys, "test_key", return_value="3") as probe:
                keys = extract_keys.keys_from_passphrase(
                    passphrase, [contact, session]
                )
        self.assertEqual(keys, {
            "contact.db": derived_a,
            "session.db": derived_b,
        })
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(probe.call_args_list[0].args[1], derived_a)
        self.assertEqual(probe.call_args_list[1].args[1], derived_b)

    def test_keys_from_passphrase_skips_when_test_key_returns_none(self):
        passphrase = bytes(range(32))
        salt = bytes(range(16))
        derived = extract_keys.derive_enc_key(passphrase, salt).hex()
        with tempfile.TemporaryDirectory() as tmp:
            contact = os.path.join(tmp, "contact.db")
            with open(contact, "wb") as fh:
                fh.write(salt)
            with mock.patch.object(extract_keys, "test_key", return_value=None) as probe:
                keys = extract_keys.keys_from_passphrase(passphrase, [contact])
        self.assertEqual(keys, {})
        probe.assert_called_once_with(contact, derived)

    def test_keys_from_passphrase_skips_missing_file_and_short_salt(self):
        passphrase = bytes(range(32))
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "missing.db")
            short = os.path.join(tmp, "short.db")
            with open(short, "wb") as fh:
                fh.write(b"\x00" * 8)
            with mock.patch.object(extract_keys, "test_key") as probe:
                keys = extract_keys.keys_from_passphrase(
                    passphrase, [missing, short]
                )
        self.assertEqual(keys, {})
        probe.assert_not_called()


class PassphraseKdfTest(unittest.TestCase):
    def test_derive_enc_key_is_deterministic(self):
        passphrase = bytes(range(32))
        salt = bytes(range(16, 32))
        first = extract_keys.derive_enc_key(passphrase, salt)
        second = extract_keys.derive_enc_key(passphrase, salt)
        self.assertEqual(len(first), 32)
        self.assertEqual(first, second)
        self.assertNotEqual(first, extract_keys.derive_enc_key(passphrase, bytes(16)))

    def test_verify_sqlcipher4_hmac_roundtrip(self):
        passphrase = bytes((i * 3) & 0xFF for i in range(32))
        salt = bytes((i * 5) & 0xFF for i in range(16))
        enc = extract_keys.derive_enc_key(passphrase, salt)
        page1 = bytearray(4096)
        page1[:16] = salt
        mac_salt = bytes(b ^ 0x3A for b in salt)
        mac_key = hashlib.pbkdf2_hmac("sha512", enc, mac_salt, 2, dklen=32)
        hmac_data = bytes(page1[16:4096 - 80 + 16])
        digest = hmac.new(mac_key, hmac_data, hashlib.sha512)
        digest.update(struct.pack("<I", 1))
        page1[4096 - 64:] = digest.digest()
        self.assertTrue(extract_keys.verify_sqlcipher4_hmac(enc, bytes(page1)))
        self.assertFalse(extract_keys.verify_sqlcipher4_hmac(b"\x00" * 32, bytes(page1)))

    def test_load_passphrase_rejects_world_readable(self):
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(b"\x11" * 32)
            path = fh.name
        os.chmod(path, 0o644)
        try:
            self.assertIsNone(extract_keys.load_passphrase(path))
        finally:
            os.unlink(path)

    def test_load_passphrase_accepts_root_only_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(b"\x22" * 32)
            path = fh.name
        os.chmod(path, 0o600)
        try:
            self.assertEqual(extract_keys.load_passphrase(path), b"\x22" * 32)
        finally:
            os.unlink(path)

    def test_load_passphrase_derefs_sparse_data_object_header(self):
        header = (b"\x00" * 8 + struct.pack("<QQ", 0x20000, 32)).ljust(32, b"\x00")
        self.assertEqual(len(header), 32)
        self.assertGreaterEqual(header.count(0), 8)
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(header)
            path = fh.name
        os.chmod(path, 0o600)
        try:
            with mock.patch.object(extract_keys, "_deref_passphrase",
                                   return_value=b"\x33" * 32) as deref:
                got = extract_keys.load_passphrase(path)
            deref.assert_called_once_with(0x20000)
            self.assertEqual(got, b"\x33" * 32)
        finally:
            os.unlink(path)


class MainTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.output_path = os.path.join(temp.name, "db_keys.json")
        self.databases = ["/data/wxid_test/db_storage/contact/contact.db",
                          "/data/wxid_test/db_storage/message/message.db"]
        self.key = bytes(range(32)).hex()
        patches = {
            "find_active_account": "wxid_test",
            "find_databases": self.databases,
            "get_build_profile": None,
            "load_passphrase": bytes(range(32)),
            "keys_from_passphrase": {},
            "extract_candidates": (0, []),
            "test_key": "3",
            "extract_image_keys": {},
        }
        self.mocks = {}
        for name, value in patches.items():
            patcher = mock.patch.object(extract_keys, name, return_value=value)
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        argv = mock.patch("sys.argv", ["extract-keys.py", "--pid", "1234",
                                       "--output", self.output_path])
        argv.start()
        self.addCleanup(argv.stop)

    def read_output(self):
        with open(self.output_path) as fh:
            return json.load(fh)

    def test_all_derived_skips_empty_scanner(self):
        expected = {os.path.basename(db): self.key for db in self.databases}
        self.mocks["keys_from_passphrase"].return_value = expected
        with redirect_stdout(io.StringIO()) as out:
            extract_keys.main()
        self.mocks["extract_candidates"].assert_not_called()
        self.mocks["extract_image_keys"].assert_called_once_with(1234, None)
        self.assertEqual(self.read_output()["keys"], expected)
        self.assertIn("Done: 2/2 databases resolved", out.getvalue())
        self.assertNotIn("NOT FOUND", out.getvalue())

    def test_partial_derived_empty_scanner_preserves_output_before_failure(self):
        expected = {"contact.db": self.key}
        self.mocks["keys_from_passphrase"].return_value = expected
        with redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as exc:
                extract_keys.main()
        self.assertEqual(exc.exception.code, 1)
        self.mocks["extract_candidates"].assert_called_once_with(1234)
        self.mocks["extract_image_keys"].assert_called_once_with(1234, None)
        self.assertEqual(self.read_output()["keys"], expected)
        self.assertIn("Done: 1/2 databases resolved", out.getvalue())
        self.assertIn("NOT FOUND: message.db", out.getvalue())
        self.assertIn("Saved to:", out.getvalue())

    def test_empty_strict_filter_reaches_valid_later_candidates(self):
        # Real filters: 22 printable bytes pass moderate; 26 require relaxed.
        for printable_count, label in [(22, "moderate"), (26, "relaxed")]:
            with self.subTest(label=label):
                raw = bytes(range(32, 32 + printable_count))
                raw += bytes(range(128, 128 + 32 - printable_count))
                key = raw.hex()
                self.mocks["load_passphrase"].return_value = None
                self.mocks["extract_candidates"].return_value = (1, [key])
                self.mocks["test_key"].reset_mock()
                with redirect_stdout(io.StringIO()) as out:
                    extract_keys.main()
                expected = {os.path.basename(db): key for db in self.databases}
                self.assertEqual(self.read_output()["keys"], expected)
                self.assertEqual(self.mocks["test_key"].call_args_list,
                                 [mock.call(db, key) for db in self.databases])
                self.assertIn(f"({label}): 1 new candidates", out.getvalue())
                self.assertIn("contact.db: resolved (3 tables)", out.getvalue())
                self.assertNotIn(key[:16], out.getvalue())
                self.assertNotIn("NOT FOUND", out.getvalue())


if __name__ == "__main__":
    unittest.main()
