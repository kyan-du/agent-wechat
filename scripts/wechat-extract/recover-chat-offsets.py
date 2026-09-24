#!/usr/bin/env python3
"""Recover chat-select offsets for a live WeChat build.

aarch64 starts from the 4.1.13.23 field offsets and rediscovers
SELECT_SESSION plus MANAGER_VT_OFF. x86_64 also walks VEC_MAP_OFF.

A candidate is accepted only when enumerate_sessions() (or the equivalent
heap walk) lists filehelper. stdout prints offsets and session counts, never
usernames other than the filehelper presence flag.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import struct
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (
    FRIDA_PYTHON_BOOTSTRAP,
    ProcMem,
    arch_name,
    elf_machine,
    emit_json,
    find_wechat_path,
    find_wechat_pid,
    iter_maps,
    log,
    plausible_ptr,
    read_build_id,
    read_std_string,
    repo_tool_path,
    resolve_tool,
)

# 4.1.13.23 (e9f1cd04) shifted +0x10 vs 4.1.1.8. discover_aarch64_layout()
# still brute-forces nearby offsets if these defaults miss.
AARCH64_LAYOUT = {
    "ARCH": "aarch64",
    "USERNAME_OFF": 0x130,
    "ELEM_SIZE": 16,
    "CTRL_OFF": 0xE8,
    "CUR_SESS_OFF": 0x40,
    "CUR_SESS_UNAME_OFF": 0x130,
    "VEC_KEY_OFF": 0x168,
}

# 4.1.13.23 x86_64 (ce28c347) flattened to the aarch64-style vector.
# Older 4.x x86 builds still used VEC_MAP_OFF; discover_x86_64_layout()
# tries both when these defaults miss.
X86_64_LAYOUT = {
    "ARCH": "x86_64",
    "USERNAME_OFF": 0x130,
    "ELEM_SIZE": 16,
    "CTRL_OFF": 0xE8,
    "CUR_SESS_OFF": 0x40,
    "CUR_SESS_UNAME_OFF": 0x130,
    "VEC_KEY_OFF": 0x168,
}

NORMAL_KEY = "normal_key"
FILEHELPER = "filehelper"
SSO_NORMAL_KEY = bytes([len(NORMAL_KEY) << 1]) + NORMAL_KEY.encode("ascii")

# aarch64 SELECT_SESSION body fingerprint shared by 4.1.1.8 and 4.1.13.23:
#   mov  x8, #-0x5555555555555556
#   mov  wN, w1
#   ldp  x9, x8, [x0]
#   sub  x8, x8, x9
#   lsr  x8, x8, #4            ; vector length in 16-byte elements
SELECT_SESSION_MOV_MAGIC = bytes.fromhex("e8f301b2")  # mov x8, #-0x5555555555555556
# ldp x9, x8, [x0]; sub x8, x8, x9; lsr x8, x8, #4
SELECT_SESSION_VEC_LEN = bytes.fromhex("092040a9080109cb08fd44d3")
# x86_64 equivalent: mov rax,[rdi]; mov rcx,[rdi+8]; sub rcx,rax; sar rcx,4
SELECT_SESSION_X86_VEC = bytes.fromhex("488b07488b4f084829c148c1f904")


def layout_for_arch(arch: str) -> dict:
    if arch == "aarch64":
        return dict(AARCH64_LAYOUT)
    if arch == "x86_64":
        return dict(X86_64_LAYOUT)
    raise ValueError(f"unsupported arch {arch}")


def mapped_wechat_paths(wechat_path: str) -> set[str]:
    """Maps list the in-container path; sidecars resolve /proc/<pid>/root/..."""
    names = {wechat_path, "/opt/wechat/wechat"}
    marker = "/root/"
    if "/proc/" in wechat_path and marker in wechat_path:
        names.add("/" + wechat_path.split(marker, 1)[-1])
    return names


def wechat_module_range(pid: int, wechat_path: str) -> tuple[int, int] | None:
    needles = mapped_wechat_paths(wechat_path)
    base = None
    end = None
    for start, stop, _perms, pathname in iter_maps(pid):
        if pathname in needles or pathname.endswith("/wechat"):
            if base is None:
                base = start
            end = stop
    if base is None:
        return None
    return base, end


def scan_sso_addrs(mem, regions) -> list[int]:
    """Return addresses of SSO 'normal_key' strings in rw memory."""
    addrs = []
    for start, end in regions:
        size = end - start
        if size <= 0 or size > 200 * 1024 * 1024:
            continue
        try:
            data = mem.read(start, size)
        except OSError:
            continue
        pos = 0
        while True:
            idx = data.find(SSO_NORMAL_KEY, pos)
            if idx < 0:
                break
            addrs.append(start + idx)
            pos = idx + 1
    return addrs


def scan_normal_key_hits(mem, regions, vec_key_off: int) -> list[int]:
    """Return candidate manager addresses from SSO 'normal_key' hits."""
    managers = []
    seen = set()
    for addr in scan_sso_addrs(mem, regions):
        manager = addr - vec_key_off
        if manager % 8 == 0 and manager not in seen:
            seen.add(manager)
            managers.append(manager)
    return managers


AARCH64_UNAME_CANDIDATES = (0x120, 0x130, 0x118, 0x128, 0x138, 0x110, 0x100)
AARCH64_CTRL_CANDIDATES = tuple(range(0x80, 0x1A0, 8))
AARCH64_VEC_KEY_CANDIDATES = tuple(range(0x140, 0x190, 8))
X86_UNAME_CANDIDATES = (0x120, 0x130, 0x138, 0x118, 0x128, 0x98, 0x110, 0x100)
X86_CTRL_CANDIDATES = tuple(range(0x80, 0x1C0, 8))
X86_VEC_KEY_CANDIDATES = tuple(range(0x140, 0x1A0, 8))
X86_VEC_MAP_CANDIDATES = tuple(range(0x80, 0x180, 8))


def discover_aarch64_layout(mem, sso_addrs, wechat_range: tuple[int, int]) -> dict | None:
    """Brute nearby field offsets from SSO hits until filehelper is readable."""
    lo, hi = wechat_range
    for sso_addr in sso_addrs:
        for vec_key_off in AARCH64_VEC_KEY_CANDIDATES:
            manager = sso_addr - vec_key_off
            if manager % 8:
                continue
            try:
                vtable = mem.read_u64(manager)
            except OSError:
                continue
            if not (lo <= vtable < hi):
                continue
            for ctrl_off in AARCH64_CTRL_CANDIDATES:
                try:
                    ctrl = mem.read_u64(manager + ctrl_off)
                except OSError:
                    continue
                if not plausible_ptr(ctrl):
                    continue
                try:
                    begin = mem.read_u64(ctrl)
                    end = mem.read_u64(ctrl + 8)
                except OSError:
                    continue
                if not plausible_ptr(begin) or not plausible_ptr(end) or end <= begin:
                    continue
                count = (end - begin) // 16
                if not (2 <= count <= 4096):
                    continue
                for uname_off in AARCH64_UNAME_CANDIDATES:
                    layout = {
                        "ARCH": "aarch64",
                        "USERNAME_OFF": uname_off,
                        "ELEM_SIZE": 16,
                        "CTRL_OFF": ctrl_off,
                        "CUR_SESS_OFF": 0x40,
                        "CUR_SESS_UNAME_OFF": uname_off,
                        "VEC_KEY_OFF": vec_key_off,
                    }
                    names = read_vector_usernames(mem, begin, end, layout)
                    if FILEHELPER not in names:
                        continue
                    cur_off, cur_uname_off = discover_current_session(mem, ctrl, names, uname_off)
                    if cur_off is not None:
                        layout["CUR_SESS_OFF"] = cur_off
                        layout["CUR_SESS_UNAME_OFF"] = cur_uname_off
                    return {
                        "manager": manager,
                        "vtable": vtable,
                        "ctrl": ctrl,
                        "sessionCount": len(names),
                        "hasFilehelper": True,
                        "names": names,
                        "layout": layout,
                    }
    return None


def discover_x86_64_layout(mem, sso_addrs, wechat_range: tuple[int, int]) -> dict | None:
    """Brute nearby x86_64 field offsets until filehelper is readable.

    4.1.13.23 may keep the unordered_map at VEC_MAP_OFF, or flatten to the
    aarch64-style vector at ctrl+0/8. Try both from each SSO hit.
    """
    lo, hi = wechat_range
    for sso_addr in sso_addrs:
        for vec_key_off in X86_VEC_KEY_CANDIDATES:
            manager = sso_addr - vec_key_off
            if manager % 8:
                continue
            try:
                vtable = mem.read_u64(manager)
            except OSError:
                continue
            if not (lo <= vtable < hi):
                continue
            for ctrl_off in X86_CTRL_CANDIDATES:
                try:
                    ctrl = mem.read_u64(manager + ctrl_off)
                except OSError:
                    continue
                if not plausible_ptr(ctrl):
                    continue
                found = _x86_sessions_from_ctrl(mem, ctrl)
                if not found:
                    continue
                names, vec_map_off, uname_off = found
                if FILEHELPER not in names:
                    continue
                layout = {
                    "ARCH": "x86_64",
                    "USERNAME_OFF": uname_off,
                    "ELEM_SIZE": 16,
                    "CTRL_OFF": ctrl_off,
                    "CUR_SESS_OFF": 0x40,
                    "CUR_SESS_UNAME_OFF": uname_off,
                    "VEC_KEY_OFF": vec_key_off,
                }
                if vec_map_off is not None:
                    layout["VEC_MAP_OFF"] = vec_map_off
                cur_off, cur_uname_off = discover_current_session(
                    mem, ctrl, names, uname_off,
                )
                if cur_off is not None:
                    layout["CUR_SESS_OFF"] = cur_off
                    layout["CUR_SESS_UNAME_OFF"] = cur_uname_off
                return {
                    "manager": manager,
                    "vtable": vtable,
                    "ctrl": ctrl,
                    "sessionCount": len(names),
                    "hasFilehelper": True,
                    "names": names,
                    "layout": layout,
                }
    return None


def _x86_sessions_from_ctrl(mem, ctrl: int):
    """Return (names, vec_map_off, uname_off) or None."""
    for uname_off in X86_UNAME_CANDIDATES:
        layout = {"USERNAME_OFF": uname_off, "ELEM_SIZE": 16, "VEC_MAP_OFF": 0}
        for vec_map_off in X86_VEC_MAP_CANDIDATES:
            layout["VEC_MAP_OFF"] = vec_map_off
            names = read_vector_usernames_x86(mem, ctrl, layout)
            if FILEHELPER in names:
                return names, vec_map_off, uname_off
        try:
            names = read_vector_usernames_aarch64(mem, ctrl, layout)
        except OSError:
            names = []
        if FILEHELPER in names:
            return names, None, uname_off
    return None


def discover_current_session(mem, ctrl: int, names: list[str], default_uname_off: int):
    name_set = set(names)
    uname_offs = (default_uname_off, 0x120, 0x130, 0x98, 0x40, 0x48)
    for off in range(0, 0x180, 8):
        try:
            ptr = mem.read_u64(ctrl + off)
        except OSError:
            continue
        if not plausible_ptr(ptr):
            continue
        for uname_off in uname_offs:
            try:
                name = read_std_string(mem, ptr + uname_off)
            except OSError:
                continue
            if name in name_set:
                return off, uname_off
    return None, default_uname_off


def read_vector_usernames_aarch64(mem, ctrl: int, layout: dict, limit: int = 512) -> list[str]:
    begin = mem.read_u64(ctrl)
    end = mem.read_u64(ctrl + 8)
    return read_vector_usernames(mem, begin, end, layout, limit)


def read_vector_usernames(mem, begin: int, end: int, layout: dict, limit: int = 512) -> list[str]:
    if not plausible_ptr(begin) or not plausible_ptr(end) or end <= begin:
        return []
    elem = layout["ELEM_SIZE"]
    count = (end - begin) // elem
    if count <= 0 or count > limit:
        return []
    names = []
    for i in range(count):
        try:
            ep = mem.read_u64(begin + i * elem)
            if not plausible_ptr(ep):
                continue
            name = read_std_string(mem, ep + layout["USERNAME_OFF"])
            if name:
                names.append(name)
        except OSError:
            continue
    return names


def read_vector_usernames_x86(mem, ctrl: int, layout: dict, limit: int = 512) -> list[str]:
    try:
        inner = mem.read_u64(ctrl + layout["VEC_MAP_OFF"])
        if not plausible_ptr(inner):
            return []
        node = mem.read_u64(inner + 0x18 + 0x10)
    except OSError:
        return []
    for _ in range(20):
        if not plausible_ptr(node):
            return []
        key = read_std_string(mem, node + 0x10)
        if key == NORMAL_KEY:
            try:
                begin = mem.read_u64(node + 0x28)
                end = mem.read_u64(node + 0x30)
            except OSError:
                return []
            return read_vector_usernames(mem, begin, end, layout, limit)
        try:
            node = mem.read_u64(node)
        except OSError:
            return []
    return []


def validate_manager(mem, manager: int, layout: dict, wechat_range: tuple[int, int]) -> dict | None:
    try:
        vtable = mem.read_u64(manager)
        ctrl = mem.read_u64(manager + layout["CTRL_OFF"])
        key = read_std_string(mem, manager + layout["VEC_KEY_OFF"])
    except OSError:
        return None
    if key != NORMAL_KEY:
        return None
    lo, hi = wechat_range
    if not (lo <= vtable < hi):
        return None
    if not plausible_ptr(ctrl):
        return None
    if layout.get("VEC_MAP_OFF") is not None:
        names = read_vector_usernames_x86(mem, ctrl, layout)
    else:
        names = read_vector_usernames_aarch64(mem, ctrl, layout)
    if not names:
        return None
    return {
        "manager": manager,
        "vtable": vtable,
        "ctrl": ctrl,
        "sessionCount": len(names),
        "hasFilehelper": FILEHELPER in names,
        "names": names,
    }


def recover_manager(pid: int, wechat_path: str, layout: dict, mem=None) -> dict | None:
    wechat_range = wechat_module_range(pid, wechat_path)
    if not wechat_range:
        return None
    own_mem = mem is None
    if own_mem:
        mem = ProcMem(pid)
    try:
        regions = [(start, end) for start, end, perms, _ in iter_maps(pid, "rw-")]
        hits = scan_normal_key_hits(mem, regions, layout["VEC_KEY_OFF"])
        best = None
        for manager in hits:
            info = validate_manager(mem, manager, layout, wechat_range)
            if not info:
                continue
            if info["hasFilehelper"]:
                info["layout"] = dict(layout)
                return info
            if best is None or info["sessionCount"] > best["sessionCount"]:
                best = info
        if best:
            best["layout"] = dict(layout)
            return best
        if layout.get("ARCH") == "aarch64":
            discovered = discover_aarch64_layout(mem, scan_sso_addrs(mem, regions), wechat_range)
            if discovered:
                return discovered
        if layout.get("ARCH") == "x86_64":
            discovered = discover_x86_64_layout(mem, scan_sso_addrs(mem, regions), wechat_range)
            if discovered:
                return discovered
        return None
    finally:
        if own_mem:
            mem.close()


def load_chat_select(path: str | None):
    candidate = resolve_tool(
        path,
        "/opt/tools/chat-select.py",
        repo_tool_path("docker", "tools", "chat-select.py"),
    )
    if not candidate:
        raise FileNotFoundError("chat-select.py not found")
    spec = importlib.util.spec_from_file_location("chat_select", candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, candidate


def verify_with_chat_select(chat_select, pid: str, profile: dict) -> dict:
    sessions, vector_base, vector_count, current_sel = chat_select.enumerate_sessions(pid, profile)
    return {
        "ok": bool(sessions) and FILEHELPER in sessions,
        "sessionCount": len(sessions),
        "hasFilehelper": FILEHELPER in sessions,
        "vectorCount": vector_count,
        "hasCurrentSel": bool(current_sel),
        "hasVector": bool(vector_base),
    }


def _elf_exec_slices(path: str) -> list[tuple[int, bytes]]:
    with open(path, "rb") as fh:
        elf = fh.read()
    if elf[:4] != b"\x7fELF":
        return []
    e_phoff = struct.unpack_from("<Q", elf, 32)[0]
    e_phentsize = struct.unpack_from("<H", elf, 54)[0]
    e_phnum = struct.unpack_from("<H", elf, 56)[0]
    slices = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, p_flags = struct.unpack_from("<II", elf, off)
        p_offset, p_vaddr, _, p_filesz, *_ = struct.unpack_from("<QQQQQQ", elf, off + 8)
        if p_type == 1 and (p_flags & 1) and p_filesz:
            slices.append((p_vaddr, elf[p_offset:p_offset + p_filesz]))
    return slices


def find_select_session_aarch64(path: str) -> int | None:
    """Return the SELECT_SESSION file/VA offset from the shared aarch64 body.

    Matches the 4.1.1.8 function: magic mov, copy of w1, vector length lsr #4,
    and a nearby `sub sp` prologue. Unique enough that 4.1.13.23 has one hit.
    """
    hits = []
    for vaddr, data in _elf_exec_slices(path):
        pos = 0
        while True:
            idx = data.find(SELECT_SESSION_MOV_MAGIC, pos)
            if idx < 0:
                break
            window = data[idx:idx + 0x100]
            if SELECT_SESSION_VEC_LEN not in window:
                pos = idx + 4
                continue
            # Require a w1 copy (mov wN, w1) in the 24 bytes around the magic.
            nearby = data[max(0, idx - 16):idx + 24]
            copied_w1 = False
            for i in range(0, len(nearby) - 3, 4):
                word = struct.unpack_from("<I", nearby, i)[0]
                # MOV (register): orr Wd, wzr, w1  -> 2a 01 03 e0 | Rd
                if (word & 0xFFFFFFE0) == 0x2A0103E0:
                    copied_w1 = True
                    break
            if not copied_w1:
                pos = idx + 4
                continue
            # Walk back at most 0x80 bytes for `sub sp, sp, #imm`.
            start = None
            for delta in range(0, 0x80, 4):
                at = idx - delta
                if at < 0:
                    break
                word = struct.unpack_from("<I", data, at)[0]
                if (word & 0xFF0003FF) == 0xD10003FF:
                    start = at
                    break
            if start is None:
                pos = idx + 4
                continue
            hits.append(vaddr + start)
            pos = idx + 4
    if len(hits) == 1:
        return hits[0]
    log(f"select-session fingerprint hits={len(hits)}")
    return None


def find_select_session_x86_64(path: str) -> int | None:
    """Return SELECT_SESSION from the x86_64 vector-length / index-check body.

    4.1.x loads begin/end from [rdi]/[rdi+8], subtracts, then `sar rcx,4`.
    Require a nearby 32-bit copy of esi (the index) so incidental vector
    walks are rejected. Walk back to a typical `push rbp; mov rbp,rsp`
    or `endbr64` prologue.
    """
    hits = []
    for vaddr, data in _elf_exec_slices(path):
        pos = 0
        while True:
            idx = data.find(SELECT_SESSION_X86_VEC, pos)
            if idx < 0:
                break
            nearby = data[max(0, idx - 48):idx + 16]
            copied_index = False
            i = 0
            while i < len(nearby) - 2:
                # mov r32, esi  (89 f0..f7)
                if nearby[i] == 0x89 and (nearby[i + 1] & 0xF8) == 0xF0:
                    copied_index = True
                    break
                # REX.W mov r64, rsi  (49 89 f0..f7), e.g. mov r12, rsi
                if nearby[i] == 0x49 and nearby[i + 1] == 0x89 and (nearby[i + 2] & 0xF8) == 0xF0:
                    copied_index = True
                    break
                i += 1
            if not copied_index:
                pos = idx + 1
                continue
            start = None
            for delta in range(0, 0x80):
                at = idx - delta
                if at < 0:
                    break
                chunk = data[at:at + 7]
                if chunk[:4] == bytes.fromhex("f30f1efa"):  # endbr64
                    start = at
                    break
                if chunk[:3] == bytes.fromhex("554889e5"):  # push rbp; mov rbp,rsp
                    start = at
                    break
                if chunk[:1] == b"\x55" and chunk[1:3] in (
                    bytes.fromhex("4157"), bytes.fromhex("4156"), bytes.fromhex("4155"),
                    bytes.fromhex("4154"), bytes.fromhex("53"),
                ):
                    start = at
                    break
            if start is None:
                pos = idx + 1
                continue
            hits.append(vaddr + start)
            pos = idx + 1
    unique = list(dict.fromkeys(hits))
    if len(unique) == 1:
        return unique[0]
    log(f"select-session x86 fingerprint hits={len(unique)}")
    return unique[0] if unique else None


def dump_vtable(mem, vtable: int, wechat_base: int, wechat_end: int, limit: int = 80) -> list[int]:
    offsets = []
    for i in range(limit):
        try:
            ptr = mem.read_u64(vtable + i * 8)
        except OSError:
            break
        if wechat_base <= ptr < wechat_end:
            offsets.append(ptr - wechat_base)
        elif ptr == 0:
            continue
        else:
            if i > 8 and not offsets:
                break
    return offsets


def frida_capture_select_session(pid: int, candidates: list[int], timeout_s: float = 8.0) -> int | None:
    """Hook candidate function offsets and return the one that fires with a small index."""
    if not candidates:
        return None
    listed = ",\n".join(f"ptr('0x{off:x}')" for off in candidates[:80])
    js = f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var offs = [{listed}];
var hits = [];
offs.forEach(function(off, i) {{
    try {{
        Interceptor.attach(b.add(off), {{
            onEnter: function(args) {{
                var idx = args[1].toInt32();
                if (idx >= 0 && idx < 4096) {{
                    hits.push({{off: off.toString(), idx: idx}});
                    send({{tag: "hit", off: off.toString(), idx: idx}});
                }}
            }}
        }});
    }} catch (e) {{}}
}});
send({{tag: "ready", hooked: offs.length}});
"""
    path = "/tmp/_recover_select.js"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(js)
    cmd = [
        sys.executable, "-c", FRIDA_PYTHON_BOOTSTRAP,
        "-p", str(pid), "-l", path, "--runtime=v8", "-q",
    ]
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE, text=True, bufsize=1,
        )
    except OSError:
        return None
    fired = None
    deadline = time.time() + timeout_s
    try:
        while time.time() < deadline:
            line = proc.stdout.readline() if proc.stdout else ""
            if not line:
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            if '"tag": "hit"' in line or "tag" in line and "hit" in line:
                try:
                    payload = json.loads(line.strip())
                    off = payload.get("off") or (payload.get("payload") or {}).get("off")
                    if off:
                        fired = int(str(off), 16) if str(off).startswith("0x") else int(off)
                        break
                except (ValueError, TypeError, json.JSONDecodeError):
                    pass
            if "hit" in line and "0x" in line:
                for tok in line.replace(",", " ").split():
                    if tok.startswith("0x"):
                        try:
                            fired = int(tok, 16)
                            break
                        except ValueError:
                            pass
                if fired is not None:
                    break
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
    return fired


def a11y_click_first_chat() -> bool:
    dump = resolve_tool("/opt/tools/a11y-dump")
    click = resolve_tool("/opt/tools/click")
    if not dump or not click:
        return xdotool_click_first_chat()
    try:
        result = subprocess.run(
            [dump, "--format", "json"],
            capture_output=True, text=True, timeout=10, check=False,
            env={**os.environ, "QT_ACCESSIBILITY": "1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1"},
        )
        tree = json.loads(result.stdout or "{}")
    except (OSError, json.JSONDecodeError, subprocess.TimeoutExpired):
        return False
    items = []

    def walk(node, in_chats=False):
        if not isinstance(node, dict) or items:
            return
        role = node.get("role", "")
        name = node.get("name", "")
        if role == "list" and name == "Chats":
            in_chats = True
        if in_chats and role == "list-item" and node.get("bounds"):
            items.append(node)
            return
        for child in node.get("children", []):
            walk(child, in_chats)

    walk(tree)
    if not items:
        return xdotool_click_first_chat()
    bounds = items[0]["bounds"]
    cx = bounds["x"] + bounds["width"] // 2
    cy = bounds["y"] + bounds["height"] // 2
    try:
        clicked = subprocess.run([click, str(cx), str(cy)], timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return xdotool_click_first_chat()
    if clicked.returncode == 0:
        return True
    return xdotool_click_first_chat()


def xdotool_click_first_chat() -> bool:
    """Click the first chat-list row via X11. Sidecars should bind /tmp/.X11-unix."""
    env = {**os.environ, "DISPLAY": os.environ.get("DISPLAY") or ":99"}
    try:
        listed = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", "Weixin"],
            capture_output=True, text=True, timeout=5, check=False, env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    wids = [tok for tok in listed.stdout.split() if tok.isdigit()]
    target = None
    geom = None
    for wid in wids:
        try:
            info = subprocess.run(
                ["xdotool", "getwindowgeometry", "--shell", wid],
                capture_output=True, text=True, timeout=5, check=False, env=env,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        parsed = {}
        for line in info.stdout.splitlines():
            if "=" in line:
                key, val = line.split("=", 1)
                parsed[key] = val
        try:
            width = int(parsed.get("WIDTH") or 0)
            height = int(parsed.get("HEIGHT") or 0)
            x = int(parsed.get("X") or 0)
            y = int(parsed.get("Y") or 0)
        except ValueError:
            continue
        if width > 800 and height > 500:
            target = wid
            geom = (x, y, width, height)
            break
    if not target or not geom:
        return False
    x, y, _width, _height = geom
    cx, cy = x + 140, y + 175
    try:
        subprocess.run(
            ["xdotool", "windowactivate", "--sync", target],
            timeout=5, check=False, env=env,
        )
        clicked = subprocess.run(
            ["xdotool", "mousemove", "--sync", str(cx), str(cy), "click", "1"],
            timeout=5, check=False, env=env,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return clicked.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Recover chat-select offsets")
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--binary", default="/opt/wechat/wechat")
    parser.add_argument("--chat-select", default=None)
    parser.add_argument("--select-session", default=None, help="Hex offset override")
    parser.add_argument("--no-click", action="store_true")
    args = parser.parse_args()

    pid = find_wechat_pid(args.pid)
    if not pid:
        emit_json({"error": "wechat_not_running"}, ok=False)
        return 1
    path = find_wechat_path(pid, args.binary)
    if not path:
        emit_json({"error": "wechat_binary_not_found"}, ok=False)
        return 1
    arch = arch_name(elf_machine(path))
    build_id = read_build_id(path)
    if not arch or not build_id:
        emit_json({"error": "build_id_unavailable"}, ok=False)
        return 1
    layout = layout_for_arch(arch)
    wechat_range = wechat_module_range(pid, path)
    if not wechat_range:
        emit_json({"error": "wechat_maps_unavailable"}, ok=False)
        return 1
    wechat_base, wechat_end = wechat_range

    info = recover_manager(pid, path, layout)
    if not info:
        emit_json({
            "buildPrefix": build_id[:8],
            "arch": arch,
            "error": "manager_not_found",
        }, ok=False)
        return 1
    layout = info.get("layout") or layout

    manager_vt_off = info["vtable"] - wechat_base
    select_session = None
    if args.select_session:
        select_session = int(args.select_session, 16)
    elif arch == "aarch64":
        select_session = find_select_session_aarch64(path)
    elif arch == "x86_64":
        select_session = find_select_session_x86_64(path)

    vtable_fns = []
    with ProcMem(pid) as mem:
        vtable_fns = dump_vtable(mem, info["vtable"], wechat_base, wechat_end)
        try:
            ctrl_vt = mem.read_u64(info["ctrl"])
            vtable_fns.extend(dump_vtable(mem, ctrl_vt, wechat_base, wechat_end))
        except OSError:
            pass
    # Preserve order, drop duplicates.
    seen = set()
    unique_fns = []
    for off in vtable_fns:
        if off not in seen:
            seen.add(off)
            unique_fns.append(off)

    if select_session is None and not args.no_click:
        log(f"hooking {len(unique_fns)} vtable functions, then clicking a chat item")
        # Start the hook first so the click is observed.
        if unique_fns:
            # Run capture concurrently with the click by spawning the hook
            # process, clicking, then parsing hits. frida_capture_select_session
            # currently waits for a hit; click from a child after READY is
            # impractical here, so click immediately after starting a brief delay.
            click_ok = {"value": False}

            def _click():
                time.sleep(2)
                click_ok["value"] = a11y_click_first_chat()

            t = threading.Thread(target=_click, daemon=True)
            t.start()
            select_session = frida_capture_select_session(pid, unique_fns)
            t.join(timeout=12)

    profile = dict(layout)
    profile["SELECT_SESSION"] = select_session if select_session is not None else 0
    profile["MANAGER_VT_OFF"] = manager_vt_off

    enum_result = None
    try:
        chat_select, _ = load_chat_select(args.chat_select)
        if select_session is not None:
            enum_result = verify_with_chat_select(chat_select, str(pid), profile)
        else:
            # enumerate_sessions does not need SELECT_SESSION.
            enum_result = verify_with_chat_select(chat_select, str(pid), profile)
    except Exception as exc:
        log(f"chat-select verify skipped: {type(exc).__name__}")
        enum_result = {
            "ok": info["hasFilehelper"],
            "sessionCount": info["sessionCount"],
            "hasFilehelper": info["hasFilehelper"],
            "vectorCount": info["sessionCount"],
            "hasCurrentSel": False,
            "hasVector": True,
            "fallback": True,
        }

    ok = bool(enum_result and enum_result.get("hasFilehelper") and manager_vt_off)
    emit_json({
        "buildPrefix": build_id[:8],
        "arch": arch,
        "SELECT_SESSION": None if select_session is None else hex(select_session),
        "MANAGER_VT_OFF": hex(manager_vt_off),
        "USERNAME_OFF": hex(layout["USERNAME_OFF"]),
        "CTRL_OFF": hex(layout["CTRL_OFF"]),
        "CUR_SESS_OFF": hex(layout["CUR_SESS_OFF"]),
        "CUR_SESS_UNAME_OFF": hex(layout["CUR_SESS_UNAME_OFF"]),
        "VEC_KEY_OFF": hex(layout["VEC_KEY_OFF"]),
        "VEC_MAP_OFF": hex(layout["VEC_MAP_OFF"]) if "VEC_MAP_OFF" in layout else None,
        "ELEM_SIZE": layout["ELEM_SIZE"],
        "sessionCount": (enum_result or {}).get("sessionCount", info["sessionCount"]),
        "hasFilehelper": (enum_result or {}).get("hasFilehelper", info["hasFilehelper"]),
        "vtableFnCount": len(unique_fns),
        "selectSessionCaptured": select_session is not None,
    }, ok=ok)
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
