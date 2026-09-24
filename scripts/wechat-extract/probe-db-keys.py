#!/usr/bin/env python3
"""Probe SQLCipher key extraction without printing key bytes.

Reports salt hits, cipher-context counts, HMAC pass/fail, and optional Frida
sqlite3_key hook counts. Candidate key material is never written to stdout.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import emit_json, find_wechat_pid, repo_tool_path, resolve_tool

SQLITE_HEADER = b"SQLite format 3\x00"
CIPHER_PATTERNS = {
    "reserve32_iv16_hmac16_page4096": bytes.fromhex("20000000100000001000000000100000"),
    "reserve32_iv16_hmac32_page4096": bytes.fromhex("20000000100000002000000000100000"),
    "reserve48_iv16_hmac16_page4096": bytes.fromhex("30000000100000001000000000100000"),
    "reserve48_iv16_hmac20_page4096": bytes.fromhex("30000000100000001400000000100000"),
    "reserve32_iv16_hmac20_page4096": bytes.fromhex("20000000100000001400000000100000"),
}


def load_extract_keys(path: str | None):
    candidate = resolve_tool(
        path,
        "/opt/tools/extract-keys.py",
        repo_tool_path("docker", "tools", "extract-keys.py"),
    )
    if not candidate:
        raise FileNotFoundError("extract-keys.py not found")
    spec = importlib.util.spec_from_file_location("extract_keys", candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, candidate


def db_header(path: str) -> dict:
    with open(path, "rb") as fh:
        head = fh.read(24)
    encrypted = head[:16] != SQLITE_HEADER[:16]
    salt = head[:16] if encrypted and len(head) >= 16 else None
    return {
        "encrypted": encrypted,
        "size": os.path.getsize(path),
        "saltPresent": bool(salt) and salt != b"\x00" * 16,
    }


def count_patterns(pid: int) -> dict:
    counts = {name: 0 for name in CIPHER_PATTERNS}
    with open(f"/proc/{pid}/maps", encoding="utf-8") as maps, \
            open(f"/proc/{pid}/mem", "rb") as mem:
        for line in maps:
            if "rw-" not in line:
                continue
            start_s, end_s = line.split()[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            pos = start
            while pos < end:
                n = min(8 * 1024 * 1024, end - pos)
                try:
                    mem.seek(pos)
                    data = mem.read(n)
                except OSError:
                    pos += n
                    continue
                for name, pattern in CIPHER_PATTERNS.items():
                    counts[name] += data.count(pattern)
                pos += n
    return counts


def try_reuse_keys(db_path: str, reuse_json: str | None, test_key) -> dict:
    reused = {"tried": 0, "verified": 0}
    if not reuse_json or not os.path.isfile(reuse_json):
        return reused
    with open(reuse_json, encoding="utf-8") as fh:
        payload = json.load(fh)
    keys = payload.get("keys") or {}
    seen = set()
    for value in keys.values():
        if not isinstance(value, str) or len(value) != 64 or value in seen:
            continue
        if value == "_image_aes" or value.startswith("_"):
            continue
        seen.add(value)
        reused["tried"] += 1
        if test_key(db_path, value) is not None:
            reused["verified"] += 1
            break
    return reused


def hook_sqlite3_key(pid: int, timeout_s: int = 8) -> dict:
    """Count sqlite3_key calls via Frida. Does not print the key bytes."""
    js = r"""
var hits = 0;
var hooked = 0;
Process.enumerateModules().forEach(function(m) {
    var names = [];
    try { names = m.enumerateExports().map(function(e) { return e.name; }); } catch (e) {}
    ["sqlite3_key", "sqlite3_key_v2", "sqlite3_rekey"].forEach(function(name) {
        try {
            var addr = Module.findExportByName(m.name, name);
            if (!addr) return;
            hooked += 1;
            Interceptor.attach(addr, {
                onEnter: function(args) {
                    hits += 1;
                    var n = args[2].toInt32();
                    send({tag: "hit", export: name, nkey: n});
                }
            });
        } catch (e) {}
    });
});
send({tag: "ready", hooked: hooked});
setTimeout(function() { send({tag: "done", hits: hits, hooked: hooked}); }, 4000);
"""
    script_path = "/tmp/_probe_sqlite3_key.js"
    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(js)
    cmd = [
        sys.executable, "-c",
        "import typing, typing_extensions; "
        "typing.NotRequired = getattr(typing, 'NotRequired', typing_extensions.NotRequired); "
        "typing.Required = getattr(typing, 'Required', typing_extensions.Required); "
        "from frida_tools.repl import main; main()",
        "-p", str(pid), "-l", script_path, "--runtime=v8", "-q",
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "error": type(exc).__name__, "hooked": 0, "hits": 0}
    hooked = 0
    hits = 0
    for line in (result.stdout or "").splitlines() + (result.stderr or "").splitlines():
        if '"tag": "ready"' in line or "hooked" in line:
            try:
                payload = json.loads(line)
                hooked = int(payload.get("hooked") or hooked)
                hits = int(payload.get("hits") or hits)
            except Exception:
                pass
        if "message:" in line and "nkey" in line:
            hits += 1
    return {"available": True, "hooked": hooked, "hits": hits}


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe WeChat SQLCipher key extraction")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--extract-keys", default=None)
    parser.add_argument("--reuse-keys", default=None, help="Existing db_keys.json to retry")
    parser.add_argument("--passphrase-file", default=None, help="32-byte login passphrase from capture-passphrase.py")
    parser.add_argument("--frida", action="store_true", help="Also hook sqlite3_key")
    parser.add_argument("--home", default="/home/wechat")
    args = parser.parse_args()

    os.environ.setdefault("HOME", args.home)
    pid = find_wechat_pid(args.pid)
    if not pid:
        emit_json({"error": "wechat_not_running"}, ok=False)
        return 1

    try:
        extract_keys, tool_path = load_extract_keys(args.extract_keys)
    except FileNotFoundError:
        emit_json({"error": "extract_keys_missing"}, ok=False)
        return 1

    build_id = extract_keys.get_build_id(pid)
    account = extract_keys.find_active_account(pid)
    dbs = extract_keys.find_databases(account) or extract_keys.find_databases()
    target = next((p for p in dbs if os.path.basename(p) == "contact.db"), dbs[0] if dbs else None)
    header = db_header(target) if target else None
    patterns = count_patterns(pid)
    ctx_count, raw_keys = extract_keys.extract_candidates(pid)

    reused = try_reuse_keys(target, args.reuse_keys, extract_keys.test_key) if target else {
        "tried": 0, "verified": 0,
    }
    passphrase = extract_keys.load_passphrase(args.passphrase_file)
    derived = 0
    if passphrase and dbs:
        derived = len(extract_keys.keys_from_passphrase(passphrase, dbs))

    hmac_pass = 0
    hmac_fail = 0
    tests = 0
    remaining = [target] if target else []
    if reused["verified"] or derived:
        hmac_pass = 1
    else:
        prev = set()
        for level in range(len(extract_keys.FILTER_LEVELS)):
            candidates = extract_keys.filter_candidates(raw_keys, level=level)
            new = [k for k in candidates if k not in prev]
            prev.update(candidates)
            still = []
            for db_path in remaining:
                found = False
                for key in new:
                    tests += 1
                    if extract_keys.test_key(db_path, key) is not None:
                        hmac_pass += 1
                        found = True
                        break
                    hmac_fail += 1
                if not found:
                    still.append(db_path)
            remaining = still
            if not remaining:
                break

    frida = hook_sqlite3_key(pid) if args.frida else {"available": False, "hooked": 0, "hits": 0}

    emit_json({
        "pid": pid,
        "buildPrefix": (build_id or "")[:8] or None,
        "extractKeysPath": os.path.basename(tool_path),
        "accountDetected": bool(account),
        "databaseCount": len(dbs),
        "target": os.path.basename(target) if target else None,
        "targetEncrypted": None if header is None else header["encrypted"],
        "saltPresent": None if header is None else header["saltPresent"],
        "cipherContexts": ctx_count,
        "rawCandidates": len(raw_keys),
        "patternHits": patterns,
        "reuseTried": reused["tried"],
        "reuseVerified": reused["verified"],
        "passphrasePresent": bool(passphrase),
        "passphraseDerived": derived,
        "hmacPass": hmac_pass,
        "hmacFail": hmac_fail,
        "tests": tests,
        "frida": frida,
    }, ok=hmac_pass > 0)
    return 0 if hmac_pass > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
