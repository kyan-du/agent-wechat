#!/usr/bin/env python3
"""Unit tests for scripts/wechat-extract. No live WeChat, no secrets."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load("wx_extract_common", "common.py")
bridge = load("wx_extract_bridge", "bridge-image-mask.py")
recover = load("wx_extract_recover", "recover-chat-offsets.py")
dump_build = load("wx_extract_dump", "dump-build.py")
capture = load("wx_extract_capture", "capture-passphrase.py")


def sso_string(text: str) -> bytes:
    raw = text.encode("ascii")
    buf = bytearray(24)
    buf[0] = len(raw) << 1
    buf[1:1 + len(raw)] = raw
    return bytes(buf)


def u64(value: int) -> bytes:
    return struct.pack("<Q", value)


class BuildProvenanceTests(unittest.TestCase):
    def test_wayback_sources_match_release_inputs(self):
        with open(os.path.join(HERE, "builds-4.1.13.23.json"), encoding="utf-8") as fh:
            builds = json.load(fh)
        with open(os.path.join(HERE, "..", "..", "docker", "release-inputs.json"), encoding="utf-8") as fh:
            release = json.load(fh)
        wechat = release["sources"]["wechat"]
        self.assertEqual(wechat["version"], builds["version"])
        for arch in ("amd64", "arm64"):
            artifact = wechat["artifacts"][arch]
            recorded = builds["architectures"][arch]
            self.assertEqual(artifact["sha256"], recorded["debSha256"])
            self.assertEqual(artifact["url"], recorded["waybackUrl"])
            self.assertIn("if_/", recorded["waybackUrl"])
            self.assertTrue(recorded["waybackUrl"].startswith("https://web.archive.org/web/"))


class CommonTests(unittest.TestCase):
    def test_arch_name(self):
        self.assertEqual(common.arch_name(183), "aarch64")
        self.assertEqual(common.arch_name(62), "x86_64")
        self.assertIsNone(common.arch_name(3))

    def test_read_std_string_sso(self):
        blob = bytearray(64)
        blob[0:24] = sso_string("normal_key")
        mem = common.ByteMem(blob)
        self.assertEqual(common.read_std_string(mem, 0), "normal_key")

    def test_load_aes_key_rejects_world_readable(self):
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(b"0123456789abcdef0123456789abcdef")
            path = fh.name
        os.chmod(path, 0o644)
        try:
            with self.assertRaises(PermissionError):
                common.load_aes_key(path=path)
        finally:
            os.unlink(path)

    def test_load_aes_key_env(self):
        key = b"0123456789abcdef0123456789abcdef"
        with mock.patch.dict(os.environ, {"WECHAT_IMAGE_AES": key.decode()}):
            self.assertEqual(common.load_aes_key(), key)


class DumpBuildTests(unittest.TestCase):
    def test_missing_binary_emits_json_failure(self):
        stream = io.StringIO()
        with mock.patch.object(sys, "argv", ["dump-build.py", "--binary", "/no/such/wechat"]):
            with mock.patch.object(dump_build, "find_wechat_pid", return_value=None):
                with redirect_stdout(stream):
                    rc = dump_build.main()
        self.assertEqual(rc, 1)
        payload = json.loads(stream.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "wechat_binary_not_found")


class BridgeMaskTests(unittest.TestCase):
    def scan_live(self, aes, elf, heap, chunk_size=64):
        def open_proc(path, *args, **kwargs):
            if path.endswith("/maps"):
                return io.StringIO(f"0-{len(heap):x} rw-p 00000000 00:00 0\n")
            if path.endswith("/mem"):
                return io.BytesIO(heap)
            raise AssertionError("unexpected file access")

        with mock.patch("builtins.open", side_effect=open_proc):
            return bridge.derive_mask_from_pid(aes, elf, 123, chunk_size)

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_prefix_matches_exhaustive_bounded_search(self):
        rng = bridge.np.random.default_rng(42)
        window = rng.integers(0, 256, 2049, dtype=bridge.np.uint8).tobytes()
        prefixes = sorted({int.from_bytes(window[i:i + 8], "little")
                           for i in range(0, len(window) - 7, 3)})
        candidates = bridge.np.array(prefixes, dtype="<u8")
        expected = [i for i in range(len(window) - 7)
                    if int.from_bytes(window[i:i + 8], "little") in prefixes]
        original = bridge.np.searchsorted

        def bounded_search(values, batch):
            self.assertLessEqual(len(batch), 7)
            self.assertFalse(batch.flags.owndata)
            return original(values, batch)

        with mock.patch.object(bridge, "SEARCH_BATCH", 7), \
                mock.patch.object(bridge.np, "searchsorted", side_effect=bounded_search), \
                mock.patch.object(bridge.np, "isin", side_effect=AssertionError("unbounded search")):
            matches = bridge._prefix_matches(window, candidates)
            self.assertEqual(list(bridge._matching_offsets(matches)), expected)
            self.assertEqual(matches.dtype, bridge.np.dtype("bool"))

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_live_all_alignments_and_chunk_boundaries(self):
        aes = b"0123456789abcdef0123456789abcdef"
        mask = bytes((i * 9 + 3) & 0xFF for i in range(32))
        elf = b"\x00" * 16 + mask + b"trailing"
        obf = bytes(a ^ b for a, b in zip(aes, mask))
        for chunk_size in (1, 7, 31, 32, 64):
            for offset in range(33, 73):
                with self.subTest(chunk_size=chunk_size, offset=offset):
                    heap = b"\xff" * offset + obf
                    result = self.scan_live(aes, elf, heap, chunk_size)
                    self.assertTrue(result["ok"])
                    self.assertEqual(result["maskHex"], mask.hex())
                    self.assertEqual(result["heapOffset"], offset)
                    self.assertEqual(result["scannedBytes"], len(heap))

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_no_matches_and_empty_candidates(self):
        aes = b"0123456789abcdef0123456789abcdef"
        for elf in (b"", b"short", b"\x00" * 32):
            for heap in (b"", b"\xff" * 7, b"\xff" * 31, b"\xff" * 193):
                with self.subTest(elf_size=len(elf), heap_size=len(heap)):
                    result = self.scan_live(aes, elf, heap)
                    self.assertFalse(result["ok"])
                    self.assertIsNone(result["maskHex"])
                    self.assertIsNone(result["heapOffset"])
                    self.assertEqual(result["prefixHits"], 0)
                    self.assertEqual(result["scannedBytes"], len(heap))
                    self.assertFalse(bridge.derive_mask(aes, elf, heap)["ok"])

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_live_address_order_and_full_half_validation(self):
        aes = b"0123456789abcdef0123456789abcdef"
        first = bytes(range(32))
        second = bytes(range(32, 64))
        elf = first + second
        obfuscate = lambda mask: bytes(a ^ b for a, b in zip(aes, mask))
        # A prefix alone is insufficient. The first real hit is not aligned.
        fake = obfuscate(first)[:8] + b"\xff" * 24
        heap = fake + b"\xff" + obfuscate(first) + b"\xff" * 7 + obfuscate(second)
        result = self.scan_live(aes, elf, heap, 256)
        self.assertEqual(result["heapOffset"], 33)
        self.assertEqual(result["maskHex"], first.hex())
        prefixes = {bytes(elf[i + j] ^ aes[j] for j in range(8))
                    for i in range(0, len(elf), 16)}
        expected_hits = sum(heap[i:i + 8] in prefixes for i in range(len(heap) - 7))
        self.assertEqual(result["prefixHits"], expected_hits)

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_low_entropy_masks_are_not_filtered(self):
        aes = b"0123456789abcdef0123456789abcdef"
        for mask in (b"\x00" * 32, b"\xff" * 32):
            with self.subTest(mask_byte=mask[0]):
                heap = bytes(a ^ b for a, b in zip(aes, mask))
                result = self.scan_live(aes, mask, heap, 9)
                self.assertTrue(result["ok"])
                self.assertEqual(result["maskHex"], mask.hex())

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_prefix_search_uint64_extremes(self):
        candidates = bridge.np.array([0, 2**64 - 1], dtype="<u8")
        window = b"\x00" * 16 + b"\xff" * 16
        expected = [i for i in range(len(window) - 7)
                    if window[i:i + 8] in (b"\x00" * 8, b"\xff" * 8)]
        self.assertEqual(list(bridge._matching_offsets(
            bridge._prefix_matches(window, candidates))), expected)

    @unittest.skipIf(bridge.np is None, "numpy is required")
    def test_progress_reports_bytes_without_secrets(self):
        aes = b"0123456789abcdef0123456789abcdef"
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(bridge.time, "monotonic", side_effect=[0, 1, 5, 6]), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.scan_live(aes, b"\x00" * 32, b"\xff" * 192)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("scanned_bytes 128", stderr.getvalue())
        self.assertEqual(stderr.getvalue().count("scanned_bytes"), 1)
        self.assertNotIn(aes.decode(), stderr.getvalue())

    def test_derive_mask_roundtrip(self):
        if bridge.np is None:
            self.skipTest("numpy is required")
        aes = b"0123456789abcdef0123456789abcdef"
        mask = bytes((i * 9 + 3) & 0xFF for i in range(32))
        elf = bytearray(64)
        elf[16:32] = mask[:16]
        elf[32:48] = mask[16:]
        obf = bytes(aes[i] ^ mask[i] for i in range(32))
        heap = b"\x00" * 64 + obf + b"\xff" * 64
        result = bridge.derive_mask(aes, bytes(elf), heap)
        self.assertTrue(result["ok"])
        self.assertEqual(result["maskHex"], mask.hex())

    def test_stdout_does_not_include_aes_key(self):
        aes = b"0123456789abcdef0123456789abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            elf_path = os.path.join(tmp, "wechat")
            heap_path = os.path.join(tmp, "heap.bin")
            key_path = os.path.join(tmp, "aes")
            with open(elf_path, "wb") as fh:
                fh.write(b"\x00" * 64)
            with open(heap_path, "wb") as fh:
                fh.write(b"\x00" * 128)
            with open(key_path, "wb") as fh:
                fh.write(aes)
            os.chmod(key_path, 0o600)
            stream = io.StringIO()
            argv = [
                "bridge-image-mask.py",
                "--binary", elf_path,
                "--heap", heap_path,
                "--aes-file", key_path,
            ]
            with mock.patch.object(sys, "argv", argv), redirect_stdout(stream):
                rc = bridge.main()
        self.assertEqual(rc, 1)
        out = stream.getvalue()
        self.assertNotIn(aes.decode(), out)
        payload = json.loads(out)
        self.assertFalse(payload["ok"])


class RecoverOffsetsTests(unittest.TestCase):
    def test_validate_manager_aarch64(self):
        layout = recover.layout_for_arch("aarch64")
        wechat_base = 0x100000
        wechat_end = 0x200000
        vtable = wechat_base + 0xABC0
        manager = 0x400000
        ctrl = 0x410000
        vector = 0x420000
        session = 0x430000
        blob = bytearray(0x500000)
        mem = common.ByteMem(blob)

        def poke(addr, data):
            blob[addr:addr + len(data)] = data

        poke(manager, u64(vtable))
        poke(manager + layout["CTRL_OFF"], u64(ctrl))
        poke(manager + layout["VEC_KEY_OFF"], sso_string("normal_key"))
        poke(ctrl, u64(vector))
        poke(ctrl + 8, u64(vector + layout["ELEM_SIZE"]))
        poke(vector, u64(session))
        poke(session + layout["USERNAME_OFF"], sso_string("filehelper"))

        info = recover.validate_manager(mem, manager, layout, (wechat_base, wechat_end))
        self.assertIsNotNone(info)
        self.assertTrue(info["hasFilehelper"])
        self.assertEqual(info["sessionCount"], 1)

    def test_validate_manager_x86_flattened(self):
        layout = recover.layout_for_arch("x86_64")
        wechat_base = 0x100000
        wechat_end = 0x200000
        vtable = wechat_base + 0xABC0
        manager = 0x400000
        ctrl = 0x410000
        vector = 0x420000
        session = 0x430000
        blob = bytearray(0x500000)
        mem = common.ByteMem(blob)

        def poke(addr, data):
            blob[addr:addr + len(data)] = data

        poke(manager, u64(vtable))
        poke(manager + layout["CTRL_OFF"], u64(ctrl))
        poke(manager + layout["VEC_KEY_OFF"], sso_string("normal_key"))
        poke(ctrl, u64(vector))
        poke(ctrl + 8, u64(vector + layout["ELEM_SIZE"]))
        poke(vector, u64(session))
        poke(session + layout["USERNAME_OFF"], sso_string("filehelper"))

        info = recover.validate_manager(mem, manager, layout, (wechat_base, wechat_end))
        self.assertIsNotNone(info)
        self.assertTrue(info["hasFilehelper"])

    def test_scan_normal_key_hits(self):
        layout = recover.layout_for_arch("aarch64")
        manager = 0x1000
        blob = bytearray(0x2000)
        blob[manager + layout["VEC_KEY_OFF"]:manager + layout["VEC_KEY_OFF"] + 24] = sso_string("normal_key")
        mem = common.ByteMem(blob)
        hits = recover.scan_normal_key_hits(mem, [(0, len(blob))], layout["VEC_KEY_OFF"])
        self.assertIn(manager, hits)

    def test_layout_x86_411323_is_flattened(self):
        layout = recover.layout_for_arch("x86_64")
        self.assertNotIn("VEC_MAP_OFF", layout)
        self.assertEqual(layout["CTRL_OFF"], 0xE8)
        self.assertEqual(layout["USERNAME_OFF"], 0x130)
        self.assertEqual(layout["VEC_KEY_OFF"], 0x168)

    def test_mapped_wechat_paths_strips_proc_root(self):
        names = recover.mapped_wechat_paths("/proc/22/root/opt/wechat/wechat")
        self.assertIn("/opt/wechat/wechat", names)

    def test_discover_x86_layout_from_sso(self):
        wechat_base = 0x100000
        wechat_end = 0x200000
        vtable = wechat_base + 0xABC0
        manager = 0x400000
        ctrl = 0x410000
        inner = 0x418000
        node = 0x419000
        vector = 0x420000
        session = 0x430000
        vec_key_off = 0x178
        ctrl_off = 0x190
        vec_map_off = 0xF0
        uname_off = 0x130
        blob = bytearray(0x500000)
        mem = common.ByteMem(blob)

        def poke(addr, data):
            blob[addr:addr + len(data)] = data

        poke(manager, u64(vtable))
        poke(manager + ctrl_off, u64(ctrl))
        poke(manager + vec_key_off, sso_string("normal_key"))
        poke(ctrl + vec_map_off, u64(inner))
        poke(inner + 0x18 + 0x10, u64(node))
        poke(node + 0x10, sso_string("normal_key"))
        poke(node + 0x28, u64(vector))
        poke(node + 0x30, u64(vector + 16))
        poke(vector, u64(session))
        poke(session + uname_off, sso_string("filehelper"))
        sso_addr = manager + vec_key_off
        info = recover.discover_x86_64_layout(mem, [sso_addr], (wechat_base, wechat_end))
        self.assertIsNotNone(info)
        self.assertTrue(info["hasFilehelper"])
        self.assertEqual(info["layout"]["CTRL_OFF"], ctrl_off)
        self.assertEqual(info["layout"]["VEC_KEY_OFF"], vec_key_off)
        self.assertEqual(info["layout"]["VEC_MAP_OFF"], vec_map_off)
        self.assertEqual(info["layout"]["USERNAME_OFF"], uname_off)

    def test_aarch64_layout_matches_411323(self):
        layout = recover.layout_for_arch("aarch64")
        self.assertEqual(layout["USERNAME_OFF"], 0x130)
        self.assertEqual(layout["CTRL_OFF"], 0xE8)
        self.assertEqual(layout["VEC_KEY_OFF"], 0x168)
        self.assertEqual(layout["CUR_SESS_UNAME_OFF"], 0x130)

    def test_find_select_session_aarch64_on_411323_elf(self):
        path = "/tmp/wechat-411323"
        if not os.path.isfile(path):
            self.skipTest("local 4.1.13.23 ELF is not present")
        offset = recover.find_select_session_aarch64(path)
        self.assertEqual(offset, 0x48543D0)

    def test_find_select_session_aarch64_synthetic(self):
        # Minimal PT_LOAD ELF containing the 4.1.13.23 SELECT_SESSION body.
        # Keep the program header outside the executable slice so the body
        # bytes are not overwritten by ELF metadata.
        body_off = 0x100
        elf = bytearray(0x200)
        elf[0:4] = b"\x7fELF"
        elf[4] = 2
        elf[5] = 1
        struct.pack_into("<H", elf, 16, 2)    # e_type ET_EXEC
        struct.pack_into("<H", elf, 18, 183)  # EM_AARCH64
        struct.pack_into("<I", elf, 20, 1)
        struct.pack_into("<Q", elf, 32, 64)   # e_phoff
        struct.pack_into("<H", elf, 52, 64)   # e_ehsize
        struct.pack_into("<H", elf, 54, 56)   # e_phentsize
        struct.pack_into("<H", elf, 56, 1)    # e_phnum
        struct.pack_into("<II", elf, 64, 1, 5)
        struct.pack_into("<QQQQQQ", elf, 72, body_off, 0, 0, 0x80, 0x80, 0x1000)
        elf[body_off:body_off + 4] = bytes.fromhex("ffc306d1")
        elf[body_off + 0x1C:body_off + 0x20] = recover.SELECT_SESSION_MOV_MAGIC
        elf[body_off + 0x24:body_off + 0x28] = bytes.fromhex("f703012a")
        elf[body_off + 0x58:body_off + 0x64] = recover.SELECT_SESSION_VEC_LEN
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(elf)
            path = fh.name
        try:
            self.assertEqual(recover.find_select_session_aarch64(path), 0)
        finally:
            os.unlink(path)

    def test_find_select_session_x86_synthetic(self):
        body_off = 0x100
        elf = bytearray(0x200)
        elf[0:4] = b"\x7fELF"
        elf[4] = 2
        elf[5] = 1
        struct.pack_into("<H", elf, 16, 2)
        struct.pack_into("<H", elf, 18, 62)  # EM_X86_64
        struct.pack_into("<I", elf, 20, 1)
        struct.pack_into("<Q", elf, 32, 64)
        struct.pack_into("<H", elf, 52, 64)
        struct.pack_into("<H", elf, 54, 56)
        struct.pack_into("<H", elf, 56, 1)
        struct.pack_into("<II", elf, 64, 1, 5)
        struct.pack_into("<QQQQQQ", elf, 72, body_off, 0, 0, 0x80, 0x80, 0x1000)
        elf[body_off:body_off + 4] = bytes.fromhex("55415753")  # push rbp; push r15; push rbx
        elf[body_off + 0x10:body_off + 0x13] = bytes.fromhex("4989f4")  # mov r12, rsi
        elf[body_off + 0x20:body_off + 0x20 + len(recover.SELECT_SESSION_X86_VEC)] = (
            recover.SELECT_SESSION_X86_VEC
        )
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(elf)
            path = fh.name
        try:
            self.assertEqual(recover.find_select_session_x86_64(path), 0)
        finally:
            os.unlink(path)


class CapturePassphraseTests(unittest.TestCase):
    def test_aarch64_profile_hooks_are_named_rvas(self):
        hooks = capture.hooks_for_build("e9f1cd04", None)
        names = [name for name, _off in hooks]
        self.assertEqual(names, ["cipher_config", "copy_key", "apply_cipher"])
        self.assertEqual(hooks[0][1], 0x83DD7E0)

    def test_amd64_profile_hooks_cipher_config(self):
        hooks = capture.hooks_for_build("ce28c347", None)
        self.assertEqual(hooks, [("cipher_config", 0x87AC370)])

    def test_unknown_build_requires_explicit_hooks(self):
        with self.assertRaises(ValueError) as ctx:
            capture.hooks_for_build("deadbeef", None)
        self.assertIn("Pass --hooks", str(ctx.exception))

    def test_hook_override_is_arch_agnostic(self):
        hooks = capture.hooks_for_build("deadbeef", "cipher_config:0x11,copy_key:0x22")
        self.assertEqual(hooks, [("cipher_config", 0x11), ("copy_key", 0x22)])

    def test_render_script_injects_offsets_without_aarch64_registers(self):
        src = capture.render_script([("cipher_config", 0x83DD7E0)])
        self.assertIn('name: "cipher_config"', src)
        self.assertIn('off: "0x83dd7e0"', src)
        self.assertIn("args[1]", src)
        self.assertIn("*(+8)", src)
        self.assertNotIn("{{HOOKS}}", src)
        self.assertNotIn("args[1] /* x1 */", src)

    def test_print_hooks_json_marks_rvas_as_arch_specific(self):
        stream = io.StringIO()
        argv = [
            "capture-passphrase.py",
            "--print-hooks",
            "--build-prefix", "e9f1cd04",
        ]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(stream):
            rc = capture.main()
        self.assertEqual(rc, 0)
        payload = json.loads(stream.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["transfer"]["archSpecific"], "hook RVAs")
        self.assertEqual(payload["transfer"]["dataObject"], "size@+16 ptr@+8")
        self.assertEqual(payload["hooks"][0]["name"], "cipher_config")

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

    def test_fresh_login_hooks_without_contact_db(self):
        stream = io.StringIO()
        argv = [
            "capture-passphrase.py",
            "--pid", "22",
            "--build-prefix", "ce28c347",
            "--timeout", "1",
        ]
        with mock.patch.object(sys, "argv", argv), redirect_stdout(stream):
            with mock.patch.object(capture, "find_wechat_pid", return_value=22):
                with mock.patch.object(capture, "find_contact_db", return_value=None):
                    with mock.patch.object(capture, "attach_and_capture", return_value={
                        "ok": False, "kind": None, "hits": 1, "cands": 0, "error": None,
                    }) as attach:
                        rc = capture.main()
        self.assertEqual(rc, 2)
        attach.assert_called_once()
        self.assertIsNone(attach.call_args.args[2])
        payload = json.loads(stream.getvalue())
        self.assertFalse(payload["ok"])
        self.assertIsNone(payload["db"])
        self.assertEqual(payload["hits"], 1)

    def test_save_passphrase_is_mode_0600(self):
        blob = bytes(range(32))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "wechat-passphrase.bin")
            capture.save_passphrase(path, blob)
            st = os.stat(path)
            self.assertEqual(st.st_mode & 0o777, 0o600)
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), blob)


class VerifyProfileTests(unittest.TestCase):
    def run_verification(self, selected, skip_select=False):
        verify = load("wx_extract_verify", "verify-profile.py")
        extractor = mock.Mock()
        extractor.get_build_id.return_value = "testbuild"
        extractor.BUILD_PROFILES = {"testbuil": {}}
        extractor.extract_image_aes_key.return_value = "a" * 32
        selector = mock.Mock()
        selector.enumerate_sessions.return_value = ({"filehelper": 0}, None, None, None)
        result = mock.Mock(stdout=json.dumps({"ok": selected, "verified": selected}))
        argv = ["verify-profile.py"] + (["--skip-select"] if skip_select else [])
        output = io.StringIO()
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(verify, "resolve_tool", return_value="tool.py"), \
                mock.patch.object(verify, "find_wechat_pid", return_value=22), \
                mock.patch.object(verify, "load_py", side_effect=[extractor, selector]), \
                mock.patch.object(verify.subprocess, "run", return_value=result), \
                redirect_stdout(output):
            code = verify.main()
        return code, json.loads(output.getvalue())

    def test_failed_selection_fails_verification(self):
        code, payload = self.run_verification(False)
        self.assertEqual(code, 2)
        self.assertFalse(payload["ok"])

    def test_successful_selection_passes_verification(self):
        code, payload = self.run_verification(True)
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])

    def test_explicit_skip_does_not_require_selection(self):
        code, payload = self.run_verification(False, skip_select=True)
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["selectFilehelperOk"])


class SecretHygieneTests(unittest.TestCase):
    def test_kit_sources_do_not_print_key_bytes(self):
        forbidden = ("print(key", "print(aes", "print(raw_keys")
        for name in (
            "dump-build.py",
            "bridge-image-mask.py",
            "probe-db-keys.py",
            "recover-chat-offsets.py",
            "verify-profile.py",
            "capture-passphrase.py",
            "common.py",
        ):
            with open(os.path.join(HERE, name), encoding="utf-8") as fh:
                text = fh.read()
            for needle in forbidden:
                self.assertNotIn(needle, text, f"{name} prints secrets via {needle}")


if __name__ == "__main__":
    unittest.main()
