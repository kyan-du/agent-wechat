#!/usr/bin/env python3
"""Derive image_xor_mask from a known 32-char _image_aes and the WeChat ELF.

The live key is stored as 32 obfuscated bytes: obf[i] = ascii_key[i] ^ mask[i].
This search supports builds whose mask halves appear as 16-byte-aligned
windows in the ELF. It does not cover x86_64 ce28c347, which constructs its
mask from four movabs imm64 instructions; a failed search does not establish
that the key is absent from memory. stdout prints no AES key.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import emit_json, load_aes_key, log

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy is optional at import for tests
    np = None


SEARCH_BATCH = 64 * 1024
PROGRESS_INTERVAL = 5.0


def _mask_candidates(aes_key: bytes, elf: bytes):
    """Keep every aligned ELF half-mask and its little-endian prefix."""
    count = len(elf) // 16
    binset = {elf[i:i + 16] for i in range(0, count * 16, 16)}
    prefixes = np.ndarray((count,), dtype="<u8", buffer=elf, strides=(16,))
    uniq8 = np.unique(prefixes ^ np.uint64(int.from_bytes(aes_key[:8], "little")))
    return binset, uniq8


def _prefix_matches(window: bytes, uniq8):
    """Match every byte offset using views and bounded search temporaries.

    Retain even incomplete 32-byte candidates for the existing prefixHits
    diagnostic; callers still validate both full 16-byte halves.
    """
    size = max(len(window) - 7, 0)
    matches = np.zeros(size, dtype=np.bool_)
    if not uniq8.size:
        return matches
    for alignment in range(min(8, size)):
        count = (size - 1 - alignment) // 8 + 1
        values = np.ndarray((count,), dtype="<u8", buffer=window,
                            offset=alignment, strides=(8,))
        for start in range(0, count, SEARCH_BATCH):
            batch = values[start:start + SEARCH_BATCH]
            positions = np.searchsorted(uniq8, batch)
            valid = positions < uniq8.size
            np.minimum(positions, uniq8.size - 1, out=positions)
            valid &= uniq8[positions] == batch
            offset = alignment + start * 8
            matches[offset:offset + len(batch) * 8:8] = valid
    return matches


def _matching_offsets(matches):
    """Yield hits in address order without allocating a full-sized hit array."""
    for start in range(0, matches.size, SEARCH_BATCH):
        for offset in np.flatnonzero(matches[start:start + SEARCH_BATCH]):
            yield start + int(offset)


def derive_mask(aes_key: bytes, elf: bytes, heap: bytes) -> dict:
    if np is None:
        raise RuntimeError("numpy is required for mask bridging")
    if len(aes_key) != 32:
        raise ValueError("AES key must be 32 ASCII bytes")

    heap_arr = np.frombuffer(heap, dtype=np.uint8)
    binset, uniq8 = _mask_candidates(aes_key, elf)
    prefix_hits = 0
    chunk = 16 * 1024 * 1024
    for start in range(0, max(heap_arr.size - 31, 0), chunk):
        window = np.ascontiguousarray(heap_arr[start:start + chunk + 31])
        if window.size < 32:
            continue
        matches = _prefix_matches(window, uniq8)
        prefix_hits += int(np.count_nonzero(matches))
        for idx in _matching_offsets(matches):
            off = start + int(idx)
            if off + 32 > heap_arr.size:
                continue
            obf32 = bytes(heap_arr[off:off + 32])
            mask_lo = bytes(obf32[i] ^ aes_key[i] for i in range(16))
            mask_hi = bytes(obf32[i] ^ aes_key[i] for i in range(16, 32))
            if mask_lo in binset and mask_hi in binset:
                return {
                    "ok": True,
                    "maskHex": (mask_lo + mask_hi).hex(),
                    "prefixHits": prefix_hits,
                    "heapOffset": off,
                }
    return {"ok": False, "maskHex": None, "prefixHits": prefix_hits, "heapOffset": None}


def derive_mask_from_pid(aes_key: bytes, elf: bytes, pid: int,
                         chunk_size: int = 16 * 1024 * 1024) -> dict:
    """Scan live rw- memory in chunks. Avoids a 1GB heap dump."""
    if np is None:
        raise RuntimeError("numpy is required for mask bridging")
    if len(aes_key) != 32:
        raise ValueError("AES key must be 32 ASCII bytes")

    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    binset, uniq8 = _mask_candidates(aes_key, elf)
    prefix_hits = 0
    scanned = 0
    last_progress = time.monotonic()
    with open(f"/proc/{pid}/maps", encoding="utf-8") as maps, \
            open(f"/proc/{pid}/mem", "rb") as mem:
        for line in maps:
            if "rw-" not in line:
                continue
            start_s, end_s = line.split()[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            pos = start
            overlap = b""
            while pos < end:
                n = min(chunk_size, end - pos)
                try:
                    mem.seek(pos)
                    data = mem.read(n)
                except OSError:
                    pos += n
                    overlap = b""
                    continue
                if not data:
                    break
                scanned += len(data)
                now = time.monotonic()
                if now - last_progress >= PROGRESS_INTERVAL:
                    log(f"scanned_bytes {scanned}")
                    last_progress = now
                window = overlap + data
                if len(window) >= 32:
                    matches = _prefix_matches(window, uniq8)
                    prefix_hits += int(np.count_nonzero(matches))
                    for off in _matching_offsets(matches):
                        if off + 32 > len(window):
                            continue
                        obf32 = window[off:off + 32]
                        mask_lo = bytes(obf32[i] ^ aes_key[i] for i in range(16))
                        mask_hi = bytes(obf32[i] ^ aes_key[i] for i in range(16, 32))
                        if mask_lo in binset and mask_hi in binset:
                            return {
                                "ok": True,
                                "maskHex": (mask_lo + mask_hi).hex(),
                                "prefixHits": prefix_hits,
                                "heapOffset": scanned - len(window) + off,
                                "scannedBytes": scanned,
                            }
                overlap = window[-31:] if len(window) >= 31 else window
                pos += len(data)
    return {
        "ok": False,
        "maskHex": None,
        "prefixHits": prefix_hits,
        "heapOffset": None,
        "scannedBytes": scanned,
    }


def dump_heap(pid: int, out_path: str, chunk_size: int = 64 * 1024 * 1024) -> int:
    """Dump rw- mappings in chunks so large arenas are not skipped."""
    written = 0
    with open(f"/proc/{pid}/maps", encoding="utf-8") as maps, \
            open(f"/proc/{pid}/mem", "rb") as mem, \
            open(out_path, "wb") as out:
        for line in maps:
            if "rw-" not in line:
                continue
            start_s, end_s = line.split()[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            pos = start
            while pos < end:
                n = min(chunk_size, end - pos)
                try:
                    mem.seek(pos)
                    data = mem.read(n)
                except OSError:
                    pos += n
                    continue
                if not data:
                    break
                out.write(data)
                written += len(data)
                pos += len(data)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge image_xor_mask from a known AES key")
    parser.add_argument("--binary", default="/opt/wechat/wechat")
    parser.add_argument("--heap", default=None, help="Existing heap dump (skip live dump)")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--aes-file", default=None, help="Root-only file with 32-char ASCII key")
    parser.add_argument("--dump-heap", default=None, help="Write a live heap dump here")
    args = parser.parse_args()

    try:
        aes_key = load_aes_key(path=args.aes_file)
    except (OSError, ValueError, PermissionError) as exc:
        emit_json({"error": "aes_key_unavailable", "detail": type(exc).__name__}, ok=False)
        return 1

    if not os.path.isfile(args.binary):
        emit_json({"error": "wechat_binary_not_found"}, ok=False)
        return 1
    with open(args.binary, "rb") as fh:
        elf = fh.read()

    heap_path = args.heap
    if heap_path is None:
        if args.pid is None:
            emit_json({"error": "pid_or_heap_required"}, ok=False)
            return 1
        if args.dump_heap:
            log(f"dumping heap to {args.dump_heap}")
            written = dump_heap(args.pid, args.dump_heap)
            log(f"heap_bytes {written}")
            with open(args.dump_heap, "rb") as fh:
                heap = fh.read()
            result = derive_mask(aes_key, elf, heap)
            result["scannedBytes"] = written
        else:
            log(f"scanning live heap pid={args.pid}")
            result = derive_mask_from_pid(aes_key, elf, args.pid)
    else:
        with open(heap_path, "rb") as fh:
            heap = fh.read()
        result = derive_mask(aes_key, elf, heap)
        result["scannedBytes"] = len(heap)

    emit_json({
        "maskHex": result["maskHex"],
        "prefixHits": result["prefixHits"],
        "heapOffset": result["heapOffset"],
        "elfBytes": len(elf),
        "heapBytes": result.get("scannedBytes"),
    }, ok=result["ok"])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
