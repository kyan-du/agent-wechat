#!/usr/bin/env python3
"""Recover candidate x86_64 image masks within a caller-selected code region.

Dependency: python3 -m pip install capstone (tested with Capstone 5).
Example (addresses are build-specific, not universal signatures):
  python3 scripts/wechat-extract/recover-image-mask.py \
    --binary /opt/wechat/wechat --start 0x619574e --size 0x3b
Add --pid PID --aes-file /secure/image-aes to check the full 32-byte XOR
encoding against Linux rw mappings. The file must satisfy common.load_aes_key
permissions and contain 32 lowercase hex ASCII characters, not decoded bytes.

--start is an ELF virtual address at an instruction boundary, NOT a file offset
or ASLR address. Only executable, file-backed ELF64 PT_LOAD data is decoded.
Select a short range around the four movabs/store pairs using disassembly.
This is not automatic function discovery or cross-build homolog mapping.
Only movabs imm64, direct 8-byte stores to rsp/rbp, and nops are accepted in a
candidate sequence. Any other instruction clears all state (including calls,
branches, register aliases, stack changes, and potentially overlapping writes).
This deliberately misses masks assembled with other instruction sequences.
Candidate words are ordered by stack displacement, not instruction order.
Static candidates are NOT verified; live verification requires a complete
32-byte match, and a miss never proves absence. No AES or obfuscated keys are
printed. Live memory is not a snapshot; scan limits and read failures matter.
"""
from __future__ import annotations

import argparse
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ProcMem, emit_json, iter_maps, load_aes_key

MAX_REGION = 1024 * 1024
MAX_CANDIDATES = 256
MAX_SCAN = 16 * 1024 ** 3
CHUNK_SIZE = 1024 * 1024


def read_region(path: str, start: int, size: int) -> tuple[bytes, int]:
    """Map a bounded ELF VA range without loading the entire binary."""
    if not 0 < size <= MAX_REGION or not 0 <= start < 2 ** 64 - size:
        raise ValueError("invalid bounded virtual address range")
    with open(path, "rb") as fh:
        length = os.fstat(fh.fileno()).st_size
        header = fh.read(64)
        if (len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01"
                or struct.unpack_from("<H", header, 18)[0] != 62):
            raise ValueError("little-endian x86_64 ELF64 required")
        phoff = struct.unpack_from("<Q", header, 32)[0]
        entsize, count = struct.unpack_from("<HH", header, 54)
        if entsize != 56 or not 0 < count <= 4096 or phoff + count * entsize > length:
            raise ValueError("invalid program header table")
        offsets = []
        for index in range(count):
            fh.seek(phoff + index * entsize)
            raw = fh.read(56)
            if len(raw) != 56:
                raise ValueError("truncated program header")
            kind, flags, offset, va, _, filesz, memsz, _ = struct.unpack("<IIQQQQQQ", raw)
            if kind != 1:
                continue
            if filesz > memsz or offset + filesz > length or va + memsz > 2 ** 64:
                raise ValueError("invalid PT_LOAD bounds")
            if flags & 1 and va <= start and start + size <= va + filesz:
                offsets.append(offset + start - va)
        if len(offsets) != 1:
            raise ValueError("range must lie in one unambiguous executable file-backed PT_LOAD")
        fh.seek(offsets[0])
        data = fh.read(size)
        if len(data) != size:
            raise ValueError("truncated code region")
        return data, offsets[0]


def recover_candidates(code: bytes, start: int) -> list[dict]:
    """Recognize only tightly grouped, independent movabs/store pairs."""
    try:
        import capstone as cs
        from capstone import x86_const as x
    except ImportError:
        raise RuntimeError("capstone is required; install with python3 -m pip install capstone") from None
    if not 0 < len(code) <= MAX_REGION:
        raise ValueError("invalid code region size")
    md = cs.Cs(cs.CS_ARCH_X86, cs.CS_MODE_64)
    md.detail = True
    registers, slots = {}, {}
    candidates, seen = [], set()
    sequence_start = start
    end = start
    for insn in md.disasm(code, start):
        end = insn.address + insn.size
        if insn.address - sequence_start > 256:
            registers.clear()
            slots.clear()
            sequence_start = insn.address
        ops = insn.operands
        if (insn.id == x.X86_INS_MOVABS and len(ops) == 2
                and ops[0].type == x.X86_OP_REG and ops[0].size == 8
                and ops[0].reg not in (x.X86_REG_RSP, x.X86_REG_RBP)
                and ops[1].type == x.X86_OP_IMM):
            registers[ops[0].reg] = (ops[1].imm & ((1 << 64) - 1), insn.address)
            continue
        if insn.id == x.X86_INS_NOP:
            continue
        if (insn.id == x.X86_INS_MOV and len(ops) == 2
                and ops[0].type == x.X86_OP_MEM and ops[0].size == 8
                and ops[0].mem.base in (x.X86_REG_RSP, x.X86_REG_RBP)
                and not ops[0].mem.index and not ops[0].mem.segment
                and ops[1].type == x.X86_OP_REG and ops[1].size == 8
                and ops[1].reg in registers):
            base, offset = ops[0].mem.base, ops[0].mem.disp
            # Different bases may alias. Partial overlaps invalidate older stores.
            slots = {k: v for k, v in slots.items()
                     if k[0] == base and abs(k[1] - offset) >= 8}
            value, source = registers.pop(ops[1].reg)
            slots[base, offset] = (value, source, insn.address)
            for first in sorted(k[1] for k in slots):
                keys = [(base, first + i * 8) for i in range(4)]
                if not all(k in slots for k in keys):
                    continue
                words = [slots[k] for k in keys]
                identity = tuple(w[2] for w in words)
                if identity in seen:
                    continue
                seen.add(identity)
                if len(candidates) >= MAX_CANDIDATES:
                    raise ValueError("too many candidates; narrow the code region")
                candidates.append({
                    "maskHex": b"".join(w[0].to_bytes(8, "little") for w in words).hex(),
                    "stackBase": insn.reg_name(base), "stackOffset": first,
                    "movabsAddresses": [hex(w[1]) for w in words],
                    "storeAddresses": [hex(w[2]) for w in words],
                    "verification": "not_verified",
                })
            continue
        registers.clear()
        slots.clear()
        sequence_start = end
    if end != start + len(code):
        raise ValueError("undecodable or truncated instruction; adjust region boundaries")
    return candidates


def validate_live(candidates: list[dict], aes: bytes, mem, mappings,
                  max_bytes: int = MAX_SCAN, chunk_size: int = CHUNK_SIZE) -> dict:
    """Scan bounded rw memory, carrying 31 bytes only across contiguous reads."""
    if len(aes) != 32 or not 0 < max_bytes <= MAX_SCAN or not 0 < chunk_size <= CHUNK_SIZE:
        raise ValueError("invalid live scan limits or key length")
    if len(candidates) > MAX_CANDIDATES:
        raise ValueError("too many candidates")
    needles = []
    for candidate in candidates:
        mask = bytes.fromhex(candidate["maskHex"])
        if len(mask) != 32:
            raise ValueError("mask must be 32 bytes")
        needles.append(bytes(a ^ b for a, b in zip(aes, mask)))
        candidate["verification"] = "not_verified"
    stats = {"readFailures": 0, "scannedBytes": 0, "attemptedBytes": 0,
             "scanLimitReached": False}
    overlap, previous_end = b"", None
    for start, end, perms, _ in mappings:
        if not perms.startswith("rw"):
            overlap, previous_end = b"", None
            continue
        if start != previous_end:
            overlap = b""
        pos = start
        while pos < end:
            remaining = max_bytes - stats["attemptedBytes"]
            if remaining <= 0:
                stats["scanLimitReached"] = True
                return stats
            n = min(chunk_size, end - pos, remaining)
            stats["attemptedBytes"] += n
            try:
                data = mem.read(pos, n)
                if len(data) != n:
                    raise OSError("short read")
            except OSError:
                stats["readFailures"] += 1
                overlap = b""
                pos += n
                continue
            stats["scannedBytes"] += len(data)
            window = overlap + data
            for candidate, needle in zip(candidates, needles):
                if needle in window:
                    candidate["verification"] = "verified"
            overlap = window[-31:]
            pos += n
        previous_end = end
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--start", required=True, type=lambda value: int(value, 0))
    parser.add_argument("--size", required=True, type=lambda value: int(value, 0), help="Bytes, maximum 1 MiB; end at an instruction boundary")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--aes-file", help="Restricted file; only used with --pid")
    parser.add_argument("--max-scan-bytes", type=lambda value: int(value, 0), default=MAX_SCAN, help="Live scan budget, at most 16 GiB (default)")
    args = parser.parse_args()
    if bool(args.pid is not None) != bool(args.aes_file) or (args.pid is not None and args.pid <= 0):
        parser.error("--pid (positive) and --aes-file must be supplied together")
    if not 0 < args.max_scan_bytes <= MAX_SCAN:
        parser.error("--max-scan-bytes must be between 1 and 16 GiB")
    try:
        code, offset = read_region(args.binary, args.start, args.size)
        candidates = recover_candidates(code, args.start)
        result = {"candidates": candidates, "startVA": hex(args.start),
                  "fileOffset": hex(offset), "size": args.size,
                  "validationRequested": args.pid is not None, "readFailures": 0}
        if args.pid is not None:
            # Bound input before delegating validation and permissions to common.
            if os.stat(args.aes_file).st_size > 4096:
                raise ValueError("AES file exceeds size limit")
            aes = load_aes_key(path=args.aes_file)
            try:
                with ProcMem(args.pid) as mem:
                    result.update(validate_live(candidates, aes, mem, iter_maps(args.pid), args.max_scan_bytes))
            except OSError:
                result.update({"validationError": "process_memory_unavailable", "readFailures": 1})
                emit_json(result, ok=False)
                return 1
        emit_json(result, ok=bool(candidates))
        return 0 if candidates else 1
    except (OSError, ValueError, RuntimeError) as exc:
        # Never include exception contents: dependencies or OS errors may expose inputs.
        emit_json({"error": type(exc).__name__, "hint": "Check ELF/range, capstone installation, and restricted AES file; see --help"}, ok=False)
        return 1


if __name__ == "__main__":
    sys.exit(main())
