#!/usr/bin/env python3
"""Capture the WeChat 4.1+ 32-byte login passphrase via Frida.

WeChat 4.1+ no longer caches the post-PBKDF SQLCipher key. A 32-byte
passphrase is applied at QR login through a Data object (size at +16,
pointer at +8). That object layout is the same on aarch64 (`x1`) and
x86_64 (`rsi`); Frida's `args[1]` covers both. HMAC-SHA512 against
contact.db proves a candidate before anything is written.

What transfers to AMD64:
  - PBKDF2-HMAC-SHA512 / 256000 / page 4096 / HMAC-64
  - Data object `*(arg1+8)` when size at +16 is 32
  - Capture must happen during QR login; heap scans of raw keys fail
  - `extract-keys.py --passphrase-file` then derives every DB key

What does NOT transfer:
  - ELF function offsets (cipher_config / copy_key / apply_cipher)
  - `image_xor_mask` and chat-select field offsets
  Pass `--hooks name:offset,...` for an unlisted BuildID. Do not reuse
  aarch64 offsets on x86_64.

Never prints key bytes. Writes a mode-0600 file only after HMAC succeeds.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import hmac
import importlib.util
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    emit_json,
    find_wechat_pid,
    log,
    repo_tool_path,
    resolve_tool,
)

HERE = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(HERE, "capture-passphrase.js")
DEFAULT_OUT = "/tmp/wechat-passphrase.bin"
PAGE = 4096

# Per-BuildID hook RVAs. AMD64 4.1.13.23 is a different ELF; locate the
# same named functions there and pass --hooks instead of copying these.
HOOK_PROFILES = {
    "e9f1cd04": {
        "arch": "aarch64",
        "hooks": (
            ("cipher_config", 0x83DD7E0),
            ("copy_key", 0x8420A40),
            ("apply_cipher", 0x83F67D8),
        ),
    },
    # x86_64 4.1.13.23: wcdb-key-tool Config.Cipher LEA RSI + 0x55 0x41 0x57 head.
    "ce28c347": {
        "arch": "x86_64",
        "hooks": (
            ("cipher_config", 0x87AC370),
        ),
    },
}


def load_extract_keys(path: str | None = None):
    candidate = resolve_tool(
        path,
        "/opt/tools/extract-keys.py",
        repo_tool_path("docker", "tools", "extract-keys.py"),
    )
    if not candidate:
        return None
    spec = importlib.util.spec_from_file_location("extract_keys", candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_hooks(raw: str) -> list[tuple[str, int]]:
    hooks = []
    for part in raw.split(","):
        item = part.strip()
        if not item:
            continue
        if ":" not in item:
            raise ValueError(f"hook {item!r} must be name:offset")
        name, off_s = item.split(":", 1)
        name = name.strip()
        off_s = off_s.strip().lower()
        if not name:
            raise ValueError("hook name is empty")
        hooks.append((name, int(off_s, 16) if off_s.startswith("0x") else int(off_s, 0)))
    if not hooks:
        raise ValueError("no hooks parsed")
    return hooks


def hooks_for_build(prefix: str | None, override: str | None) -> list[tuple[str, int]]:
    if override:
        return parse_hooks(override)
    if prefix and prefix in HOOK_PROFILES:
        return list(HOOK_PROFILES[prefix]["hooks"])
    known = ", ".join(sorted(HOOK_PROFILES))
    raise ValueError(
        f"no passphrase-capture hooks for BuildID {prefix or 'unknown'}; "
        f"known={known or 'none'}. Pass --hooks name:offset,..."
    )


def render_script(hooks: list[tuple[str, int]], template: str | None = None) -> str:
    if template is not None:
        src = template
    else:
        with open(JS_PATH, encoding="utf-8") as fh:
            src = fh.read()
    listed = ",\n".join(
        f'    {{name: "{name}", off: "0x{off:x}"}}' for name, off in hooks
    )
    if "{{HOOKS}}" not in src:
        raise ValueError("capture-passphrase.js is missing {{HOOKS}} placeholder")
    return src.replace("{{HOOKS}}", f"[\n{listed}\n]")


def find_contact_db(pid: int, home: str = "/home/wechat") -> str | None:
    roots = [
        f"/proc/{pid}/root{home}/xwechat_files",
        os.path.expanduser(f"{home}/xwechat_files"),
        os.path.expanduser("~/xwechat_files"),
    ]
    matches = []
    for root in roots:
        matches.extend(glob.glob(os.path.join(root, "*/db_storage/contact/contact.db")))
    existing = [p for p in matches if os.path.isfile(p)]
    if not existing:
        return None
    return max(existing, key=os.path.getmtime)


def looks_key(blob: bytes) -> bool:
    return len(blob) == 32 and sum(1 for b in blob if b) >= 16 and len(set(blob)) >= 8


def hmac64_ok(enc_key: bytes, page1: bytes) -> bool:
    if len(page1) < PAGE or len(enc_key) != 32:
        return False
    salt = page1[:16]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=32)
    data = page1[16: PAGE - 80 + 16]
    digest = hmac.new(mac_key, data, hashlib.sha512)
    digest.update(struct.pack("<I", 1))
    return digest.digest() == page1[PAGE - 64:]


def classify_blob(blob: bytes, page1: bytes, extract_keys=None) -> str | None:
    """Return 'passphrase' or 'rawkey' when HMAC-64 matches. Never logs bytes."""
    if not looks_key(blob):
        return None
    salt = page1[:16]
    if extract_keys is not None:
        enc = extract_keys.derive_enc_key(blob, salt)
        if extract_keys.verify_sqlcipher4_hmac(enc, page1):
            return "passphrase"
        if extract_keys.verify_sqlcipher4_hmac(blob, page1):
            return "rawkey"
        return None
    enc = hashlib.pbkdf2_hmac("sha512", blob, salt, 256000, dklen=32)
    if hmac64_ok(enc, page1):
        return "passphrase"
    if hmac64_ok(blob, page1):
        return "rawkey"
    return None


def save_passphrase(path: str, blob: bytes) -> None:
    if len(blob) != 32:
        raise ValueError("passphrase must be 32 bytes")
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, blob)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)


def read_page1(db_path: str | None) -> bytes | None:
    if not db_path or not os.path.isfile(db_path):
        return None
    with open(db_path, "rb") as fh:
        page1 = fh.read(PAGE)
    return page1 if len(page1) >= PAGE else None


def attach_and_capture(pid: int, script_src: str, page1: bytes | None, out_path: str,
                       timeout_s: float, extract_keys=None,
                       db_finder=None) -> dict:
    try:
        import frida
    except ImportError:
        return {"ok": False, "error": "frida_missing", "hits": 0, "cands": 0}

    state = {
        "ok": False,
        "kind": None,
        "cands": 0,
        "hits": 0,
        "error": None,
        "pending": [],
        "page1": page1,
        "db": None,
    }
    script_holder = {}

    def try_verify(blob: bytes, src: str) -> bool:
        current = state["page1"]
        if current is None:
            state["pending"].append((bytes(blob), src))
            log(f"cand_pending {src} n={state['cands']}")
            return False
        kind = classify_blob(bytes(blob), current, extract_keys)
        if kind:
            save_passphrase(out_path, bytes(blob))
            state["ok"] = True
            state["kind"] = kind
            log(f"verified {kind} from {src}")
            try:
                script_holder["script"].exports_sync.mark_captured()
            except Exception:
                pass
            return True
        log(f"cand_fail {src} n={state['cands']}")
        return False

    def refresh_db() -> None:
        if state["page1"] is not None or db_finder is None:
            return
        db_path = db_finder()
        page = read_page1(db_path)
        if page is None:
            return
        state["page1"] = page
        state["db"] = os.path.basename(db_path)
        log("contact_db_ready")
        for blob, src in list(state["pending"]):
            if try_verify(blob, src + ":late"):
                break

    def on_message(message, data):
        payload = message.get("payload") if isinstance(message, dict) else None
        if not isinstance(payload, dict):
            if isinstance(message, dict) and message.get("type") == "error":
                log(f"frida error: {message.get('description')}")
            return
        tag = payload.get("tag")
        if tag == "cand" and data:
            state["cands"] += 1
            try_verify(bytes(data), payload.get("src") or "cand")
            return
        if tag == "hit":
            state["hits"] += 1
            log(f"hit {payload.get('site')} n={payload.get('n')} hits={state['hits']}")
            return
        if tag == "hook_fail":
            log(f"hook_fail {payload.get('site')}: {payload.get('err')}")
            return
        if tag in ("hooked", "ready", "data"):
            extra = {k: v for k, v in payload.items() if k != "tag"}
            log(f"{tag} {extra}")

    try:
        session = frida.get_local_device().attach(pid)
        script = session.create_script(script_src, runtime="v8")
        script_holder["script"] = script
        script.on("message", on_message)
        script.load()
    except Exception as exc:
        return {
            "ok": False,
            "error": type(exc).__name__,
            "hits": 0,
            "cands": 0,
        }

    deadline = time.time() + timeout_s
    try:
        while time.time() < deadline and not state["ok"]:
            refresh_db()
            time.sleep(0.3)
    finally:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass
    return {
        "ok": state["ok"],
        "kind": state["kind"],
        "hits": state["hits"],
        "cands": state["cands"],
        "error": state["error"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture WeChat 4.1+ login passphrase")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--hooks", default=None,
                        help="name:offset,... override (hex offsets from wechat base)")
    parser.add_argument("--output", default=DEFAULT_OUT)
    parser.add_argument("--db", default=None, help="contact.db used for HMAC proof")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--home", default="/home/wechat")
    parser.add_argument("--extract-keys", default=None)
    parser.add_argument("--print-hooks", action="store_true",
                        help="Print selected hook RVAs as JSON and exit")
    parser.add_argument("--build-prefix", default=None,
                        help="Override BuildID prefix when WeChat is not running")
    args = parser.parse_args()

    extract_keys = load_extract_keys(args.extract_keys)
    pid = find_wechat_pid(args.pid)
    prefix = args.build_prefix
    if extract_keys and pid and not prefix:
        build_id = extract_keys.get_build_id(pid)
        prefix = (build_id or "")[:8] or None

    try:
        hooks = hooks_for_build(prefix, args.hooks)
    except ValueError as exc:
        emit_json({"error": "hooks_unavailable", "detail": str(exc),
                   "buildPrefix": prefix}, ok=False)
        return 1

    hook_payload = [{"name": name, "offset": f"0x{off:x}"} for name, off in hooks]
    if args.print_hooks:
        emit_json({
            "buildPrefix": prefix,
            "hooks": hook_payload,
            "transfer": {
                "protocol": "sqlcipher4-passphrase",
                "dataObject": "size@+16 ptr@+8",
                "archSpecific": "hook RVAs",
            },
        }, ok=True)
        return 0

    if not pid:
        emit_json({"error": "wechat_not_running", "hooks": hook_payload}, ok=False)
        return 1

    db_path = args.db or find_contact_db(pid, args.home)
    page1 = read_page1(db_path)
    if page1 is None:
        log("contact_db_missing; hooking anyway and waiting for login")

    try:
        script_src = render_script(hooks)
    except (OSError, ValueError) as exc:
        emit_json({"error": "script_render_failed", "detail": type(exc).__name__}, ok=False)
        return 1

    log(f"capturing pid={pid} timeout={args.timeout}s hooks={len(hooks)}")
    result = attach_and_capture(
        pid, script_src, page1, args.output, args.timeout, extract_keys,
        db_finder=lambda: args.db or find_contact_db(pid, args.home),
    )
    payload = {
        "pid": pid,
        "buildPrefix": prefix,
        "hooks": hook_payload,
        "db": os.path.basename(db_path) if db_path else None,
        "hits": result.get("hits", 0),
        "candidates": result.get("cands", 0),
        "kind": result.get("kind"),
        "output": args.output if result.get("ok") else None,
    }
    if result.get("error"):
        payload["error"] = result["error"]
    emit_json(payload, ok=bool(result.get("ok")))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
