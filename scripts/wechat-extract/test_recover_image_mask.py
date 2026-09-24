#!/usr/bin/env python3
"""Synthetic-only tests for bounded image mask reconstruction and validation."""
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("recover_image_mask", Path(__file__).with_name("recover-image-mask.py"))
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
HAS_CAPSTONE = importlib.util.find_spec("capstone") is not None
MASK = bytes(range(32))


def pair(index, offset=None, base="rsp"):
    immediate = b"\x48\xb8" + MASK[index * 8:index * 8 + 8]
    displacement = (index * 8 if offset is None else offset) & 255
    store = (b"\x48\x89\x44\x24" if base == "rsp" else b"\x48\x89\x45") + bytes([displacement])
    return immediate + store


def candidate():
    return {"maskHex": MASK.hex(), "verification": "not_verified"}


@unittest.skipUnless(HAS_CAPSTONE, "optional capstone is not installed")
class ReconstructionTests(unittest.TestCase):
    def recover(self, code):
        return recovery.recover_candidates(code, 0x619574e)

    def test_adjacent_rsp_with_provenance(self):
        result = self.recover(b"".join(pair(i) for i in range(4)))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["maskHex"], MASK.hex())
        self.assertEqual(result[0]["movabsAddresses"], [hex(0x619574e + 15 * i) for i in range(4)])
        self.assertEqual(result[0]["storeAddresses"][0], hex(0x619574e + 10))
        self.assertEqual(result[0]["verification"], "not_verified")

    def test_documented_movabs_layout(self):
        mask = bytes.fromhex("4e9379223c6eeed2ae11ed50510d0e153929e23541a7288ac021a10e6d4b4655")
        code = b""
        for i in range(4):
            code += b"\x48\xb8" + mask[i * 8:i * 8 + 8]
            code += b"\x48\x89\x04\x24" if i == 0 else b"\x48\x89\x44\x24" + bytes([i * 8])
        result = self.recover(code)[0]
        self.assertEqual(len(code), 0x3b)
        self.assertEqual(result["maskHex"], mask.hex())
        self.assertEqual(result["movabsAddresses"], ["0x619574e", "0x619575c", "0x619576b", "0x619577a"])

    def test_stack_order_rbp_negative_offsets(self):
        result = self.recover(b"".join(pair(i, -32 + i * 8, "rbp") for i in (3, 1, 0, 2)))
        self.assertEqual(result[0]["maskHex"], MASK.hex())
        self.assertEqual(result[0]["stackOffset"], -32)

    def test_interruptions_clear_state(self):
        for instruction in (b"\x31\xc0", b"\xeb\x00", b"\xe8\x00\x00\x00\x00", b"\x48\x83\xc4\x08", b"\xc3", b"\xc6\x04\x24\x00"):
            with self.subTest(instruction=instruction.hex()):
                self.assertEqual(self.recover(pair(0) + instruction + b"".join(pair(i) for i in (1, 2, 3))), [])

    def test_register_overwrite_before_store(self):
        code = pair(0)[:10] + b"\x31\xc0" + pair(0)[10:] + b"".join(pair(i) for i in (1, 2, 3))
        self.assertEqual(self.recover(code), [])

    def test_disjoint_mixed_and_overlapping_slots(self):
        for code in (b"".join(pair(i, i * 16) for i in range(4)),
                     pair(0, base="rbp") + b"".join(pair(i) for i in (1, 2, 3)),
                     pair(0) + pair(1, 4) + pair(2) + pair(3)):
            self.assertEqual(self.recover(code), [])

    def test_nops_allowed_but_long_sequences_expire(self):
        self.assertEqual(len(self.recover(pair(0) + b"\x90" + b"".join(pair(i) for i in (1, 2, 3)))), 1)
        self.assertEqual(self.recover(pair(0) + b"\x90" * 257 + b"".join(pair(i) for i in (1, 2, 3))), [])

    def test_truncated_instruction_rejected(self):
        with self.assertRaises(ValueError):
            self.recover(pair(0) + b"\x48\xb8")


class ElfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic.elf"
        data = bytearray(0x200)
        data[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<H", data, 18, 62)
        struct.pack_into("<Q", data, 32, 64)
        struct.pack_into("<HH", data, 54, 56, 1)
        struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0x100, 0x1100, 0, 0x100, 0x200, 0x1000)
        data[0x110:0x114] = b"test"
        self.path.write_bytes(data)

    def test_pt_load_mapping(self):
        self.assertEqual(recovery.read_region(str(self.path), 0x1110, 4), (b"test", 0x110))

    def test_file_offsets_bss_and_excessive_limits_rejected(self):
        for start, size in ((0x110, 4), (0x1200, 4), (0x1110, recovery.MAX_REGION + 1), (0x1110, 0)):
            with self.assertRaises(ValueError):
                recovery.read_region(str(self.path), start, size)

    def test_truncated_and_wrong_architecture(self):
        wrong_arch = bytearray(self.path.read_bytes())
        struct.pack_into("<H", wrong_arch, 18, 183)
        for data in (b"\x7fELF", self.path.read_bytes()[:100], wrong_arch):
            self.path.write_bytes(data)
            with self.assertRaises(ValueError):
                recovery.read_region(str(self.path), 0x1110, 4)


class LiveTests(unittest.TestCase):
    AES = b"0123456789abcdef0123456789abcdef"

    def encoded(self):
        return bytes(a ^ b for a, b in zip(self.AES, MASK))

    def scan(self, blob, chunk_size=16, mappings=None, max_bytes=1024, mem=None):
        candidates = [candidate()]
        if mem is None:
            raise ValueError("synthetic memory must be supplied")
        stats = recovery.validate_live(candidates, self.AES, mem,
                                       mappings or [(0, len(blob), "rw-p", "")],
                                       chunk_size=chunk_size, max_bytes=max_bytes)
        return candidates[0], stats

    def test_chunk_and_adjacent_mapping_overlap(self):
        from common import ByteMem
        blob = b"abc" + self.encoded() + b"xyz"
        for mappings in (None, [(0, 16, "rw-p", ""), (16, len(blob), "rw-p", "")]):
            value, stats = self.scan(blob, mappings=mappings, mem=ByteMem(bytearray(blob)))
            self.assertEqual(value["verification"], "verified")
            self.assertEqual(stats["readFailures"], 0)

    def test_full_32_bytes_required(self):
        from common import ByteMem
        blob = self.encoded()[:31] + b"!"
        value, _ = self.scan(blob, mem=ByteMem(bytearray(blob)))
        self.assertEqual(value["verification"], "not_verified")

    def test_failure_and_limit_reported(self):
        class FailingMem:
            def read(self, addr, size):
                raise OSError("synthetic failure")
        value, stats = self.scan(bytes(64), mem=FailingMem(), max_bytes=32)
        self.assertEqual(stats["readFailures"], 2)
        self.assertEqual(stats["scannedBytes"], 0)
        self.assertTrue(stats["scanLimitReached"])
        self.assertEqual(value["verification"], "not_verified")

    def test_no_overlap_across_gaps_or_failed_reads(self):
        encoded = self.encoded()
        class GapMem:
            def read(self, addr, size):
                if addr == 16:
                    raise OSError("gap")
                return encoded[:16] if addr == 0 else encoded[16:]
        for mappings in ([(0, 48, "rw-p", "")], [(0, 16, "rw-p", ""), (32, 48, "rw-p", "")]):
            value, _ = self.scan(bytes(48), mem=GapMem(), mappings=mappings)
            self.assertEqual(value["verification"], "not_verified")

    def test_short_read_is_failure(self):
        class ShortMem:
            def read(self, addr, size):
                return b"x"
        _, stats = self.scan(bytes(16), mem=ShortMem())
        self.assertEqual(stats["readFailures"], 1)

    def test_aes_file_restrictions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic-key"
            path.write_bytes(self.AES)
            os.chmod(path, 0o644)
            with self.assertRaises(PermissionError):
                recovery.load_aes_key(path=str(path))
            os.chmod(path, 0o600)
            self.assertEqual(recovery.load_aes_key(path=str(path)), self.AES)


if __name__ == "__main__":
    unittest.main()
