#!/usr/bin/env python3
"""
Programmatic chat selection for WeChat Linux.

Selects a chat by username (e.g. "wxid_xxx", "123@chatroom", "filehelper")
without requiring manual user interaction. Works on both aarch64 and x86_64.

Usage:
    chat-select <username>          # Select a chat, output JSON result
    chat-select --verify-only <username>  # Confirm current selection, no UI action
    chat-select --list              # List all sessions as JSON

Output (JSON):
    {"ok": true, "username": "filehelper", "index": 3, "verified": true}
    {"ok": false, "error": "Chat not found in session list"}
    {"ok": true, "sessions": {"filehelper": 0, "wxid_xxx": 1, ...}}
"""
import subprocess
import time
import sys
import json
import os
import re
import select

# ── Per-build constants ──────────────────────────────────────────────────────
# Keyed by first 8 hex chars of ELF BuildID (same pattern as extract-keys.py).

BUILD_PROFILES = {
    # WeChat Linux v4.1.0.16 aarch64 (BuildID: 5233a112...)
    "5233a112": {
        "ARCH": "aarch64",
        "SELECT_SESSION": 0x38bd3d0,
        "USERNAME_OFF": 0x120,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7b3be28,
        "CTRL_OFF": 0xd8,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x120,
        "VEC_KEY_OFF": 0x158,
    },
    # WeChat Linux v4.1.0.16 x86_64 (BuildID: f8713825...)
    "f8713825": {
        "ARCH": "x86_64",
        "SELECT_SESSION": 0x3909e50,
        "USERNAME_OFF": 0x138,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7fc7f50,
        "CTRL_OFF": 0x180,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x98,
        "VEC_KEY_OFF": 0x168,
        "VEC_MAP_OFF": 0xe8,
    },
    # WeChat Linux 4.x aarch64 (BuildID: 3eda8254...)
    "3eda8254": {
        "ARCH": "aarch64",
        "SELECT_SESSION": 0x3937ff8,
        "USERNAME_OFF": 0x120,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7ce8ea8,
        "CTRL_OFF": 0xd8,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x120,
        "VEC_KEY_OFF": 0x158,
    },
    # WeChat Linux v4.1.1.8 aarch64 (BuildID: 9a3558be...)
    "9a3558be": {
        "ARCH": "aarch64",
        "SELECT_SESSION": 0x3939ff8,
        "USERNAME_OFF": 0x120,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7db5570,
        "CTRL_OFF": 0xd8,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x120,
        "VEC_KEY_OFF": 0x158,
    },
    # WeChat Linux 4.x x86_64 (BuildID: eba86b80...)
    "eba86b80": {
        "ARCH": "x86_64",
        "SELECT_SESSION": 0x3988e60,
        "USERNAME_OFF": 0x120,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x8197d10,
        "CTRL_OFF": 0x180,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x98,
        "VEC_KEY_OFF": 0x168,
        "VEC_MAP_OFF": 0xe8,
    },
}

FRIDA_PYTHON_BOOTSTRAP = (
    "import typing, typing_extensions; "
    "typing.NotRequired = getattr(typing, 'NotRequired', typing_extensions.NotRequired); "
    "typing.Required = getattr(typing, 'Required', typing_extensions.Required); "
    "from frida_tools.repl import main; main()"
)
FRIDA_ENUM_TIMEOUT = 10
FRIDA_READY_TIMEOUT = 5
FRIDA_HOOK_TIMEOUT = 4
MAX_ENUM_ATTEMPTS = 1
_START_TIME = time.monotonic()
_DIAGNOSTICS = {"used_frida": False, "frida_attach_count": 0}


class FridaError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def log(msg):
    """Log to stderr (not mixed with JSON stdout)."""
    print(msg, file=sys.stderr, flush=True)


_GH_RE = re.compile(r'^gh_[0-9a-f]+$')

def is_official_account(username):
    """WeChat official/service accounts match gh_<hex>."""
    return bool(_GH_RE.match(username))


def result_json(ok, **kwargs):
    """Print a redacted, machine-readable result and exit."""
    out = {
        "ok": ok,
        "usedFrida": _DIAGNOSTICS["used_frida"],
        "fridaAttachCount": _DIAGNOSTICS["frida_attach_count"],
        "durationMs": int((time.monotonic() - _START_TIME) * 1000),
        **kwargs,
    }
    print(json.dumps(out))
    sys.exit(0 if ok else 1)


def fail(code, message, **kwargs):
    result_json(False, errorCode=code, error=message, **kwargs)


def get_pid():
    """Get WeChat PID."""
    for cmd in [["pgrep", "-x", "wechat"], ["pgrep", "-f", "/opt/wechat/wechat"]]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            pids = r.stdout.strip().split()
            if pids:
                return pids[0]
        except Exception:
            pass
    return None


def get_build_id(pid):
    """Read the WeChat binary's BuildID from /proc/pid/maps + readelf."""
    wechat_path = None
    try:
        with open(f"/proc/{pid}/maps") as f:
            for line in f:
                if "/wechat" in line and line.strip().endswith("/wechat"):
                    wechat_path = line.split()[-1]
                    break
    except Exception:
        pass
    if not wechat_path:
        return None
    try:
        r = subprocess.run(["readelf", "-n", wechat_path], capture_output=True, text=True)
        for line in r.stdout.split("\n"):
            if "Build ID:" in line:
                return line.split("Build ID:")[1].strip()
    except Exception:
        pass
    return None


def get_profile(pid):
    """Look up build profile by BuildID prefix."""
    build_id = get_build_id(pid)
    if not build_id:
        return None, "Could not read WeChat BuildID"
    prefix = build_id[:8]
    profile = profile_for_build_id(build_id)
    log(f"[chat-select] Build profile matched={profile is not None}")
    if not profile:
        return None, "Unsupported WeChat build"
    log(f"[chat-select] Profile arch={profile['ARCH']}")
    return profile, None


def profile_for_build_id(build_id):
    """Look up a build profile by a full BuildID string."""
    if not build_id:
        return None
    return BUILD_PROFILES.get(build_id[:8])


def frida_command(pid, script_path, quiet=False):
    """Build a Frida CLI command with a Python 3.10 typing shim.

    frida 17.x imports Required/NotRequired from typing, which is only native
    in Python 3.11+. Ubuntu 22.04 runs Python 3.10, so invoke the CLI through a
    tiny bootstrap that exposes the typing_extensions backports first.
    """
    args = [
        sys.executable,
        "-c",
        FRIDA_PYTHON_BOOTSTRAP,
        "-p",
        pid,
        "-l",
        script_path,
        "--runtime=v8",
    ]
    if quiet:
        args.append("-q")
    return args


def find_chat_item_from_a11y():
    """Use a11y-dump to find a clickable chat list item. Returns (x, y) or None."""
    try:
        log("[chat-select] Getting a11y tree...")
        r = subprocess.run(
            ["/opt/tools/a11y-dump", "--format", "json"],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "QT_ACCESSIBILITY": "1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1"}
        )
        if r.returncode != 0:
            log(f"[chat-select] a11y-dump failed exit_code={r.returncode}")
            return None

        tree = json.loads(r.stdout)
        # Walk tree to find: list[name="Chats"] > list-item with bounds
        items = []
        _find_chat_list_items(tree, items, in_chat_list=False)
        if not items:
            log("[chat-select] No list-item found in Chats list")
            return None

        # Return center of the first item with valid bounds
        item = items[0]
        b = item["bounds"]
        cx = b["x"] + b["width"] // 2
        cy = b["y"] + b["height"] // 2
        log(f"[chat-select] Found live chat-list click target bounds={b}")
        return (cx, cy)
    except Exception:
        log("[chat-select] a11y inspection failed")
        return None


def _find_chat_list_items(node, items, in_chat_list):
    """Recursively find list-item nodes inside the Chats list."""
    if not node or not isinstance(node, dict):
        return

    role = node.get("role", "")
    name = node.get("name", "")

    # Detect if we're inside the chat list
    if role == "list" and name == "Chats":
        in_chat_list = True

    if in_chat_list and role == "list-item" and node.get("bounds"):
        items.append(node)
        if len(items) >= 1:
            return  # Only need one

    for child in node.get("children", []):
        _find_chat_list_items(child, items, in_chat_list)
        if len(items) >= 1:
            return


def write_js(path, content):
    with open(path, "w") as f:
        f.write(content)


READ_STD_STRING_JS = """
function readStdString(addr) {
    try {
        if (!addr || addr.isNull() || addr.compare(ptr(0x10000)) < 0) return null;
        var b0 = addr.readU8();
        if (b0 & 1) {
            var len = Number(addr.add(8).readU64());
            var dp = addr.add(16).readPointer();
            if (len > 0 && len < 512 && dp && !dp.isNull()) return dp.readUtf8String(len);
        } else {
            var len = b0 >> 1;
            if (len > 0 && len <= 22) return addr.add(1).readUtf8String(len);
        }
    } catch(e) {}
    return null;
}
"""


def read_lines_until(proc, timeout, stop_on=None):
    """Read output lines from proc.stdout until stop_on appears, EOF, or the
    wall-clock deadline expires. Returns the lines read (rstripped).

    A plain proc.stdout.readline() blocks indefinitely when the child stays
    alive but silent (e.g. a frida hook that never fires), defeating any
    time-based loop guard — that hang is what used to make `wx send` time out.
    This reads the raw fd non-blocking behind select(), so the deadline holds
    even for partial lines, and select() can never miss data stranded in a
    Python-level buffer (we own the only buffer, kept on the proc object so
    consecutive calls on the same proc don't lose bytes read past stop_on).
    """
    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    deadline = time.time() + timeout
    buf = getattr(proc, "_read_buf", b"")
    lines = []
    try:
        while True:
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").rstrip()
                lines.append(line)
                if stop_on and stop_on in line:
                    return lines
            remaining = deadline - time.time()
            if remaining <= 0:
                return lines  # deadline expired
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                return lines  # deadline expired waiting for output
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                return lines
            if not chunk:
                return lines  # EOF
            buf += chunk
    finally:
        proc._read_buf = buf


ATTACH_COUNT_PATH = "/tmp/agent-wechat-frida-attach-count"


def record_frida_attach():
    _DIAGNOSTICS["used_frida"] = True
    _DIAGNOSTICS["frida_attach_count"] += 1
    try:
        try:
            with open(ATTACH_COUNT_PATH, encoding="utf-8") as fh:
                n = int(fh.read().strip() or "0")
        except (OSError, ValueError):
            n = 0
        with open(ATTACH_COUNT_PATH, "w", encoding="utf-8") as fh:
            fh.write(str(n + 1))
    except OSError:
        pass


def run_frida_script(pid, script_path, timeout=FRIDA_ENUM_TIMEOUT, stop_on="SCRIPT_DONE"):
    """Run a bounded Frida script and require its terminal marker."""
    record_frida_attach()
    try:
        proc = subprocess.Popen(
            frida_command(pid, script_path, quiet=True),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE, text=True, bufsize=1,
        )
    except OSError as exc:
        raise FridaError("FRIDA_ATTACH_FAILED", "Frida could not start") from exc
    try:
        lines = read_lines_until(proc, timeout, stop_on=stop_on)
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
        time.sleep(0.2)
    if any("Failed to attach" in line or "Unable to attach" in line for line in lines):
        raise FridaError("FRIDA_ATTACH_FAILED", "Frida attach failed")
    if stop_on and not any(stop_on in line for line in lines):
        raise FridaError("FRIDA_ATTACH_TIMEOUT", "Frida attach timed out")
    return lines


def run_frida_bg(pid, script_path):
    """Start Frida and fail closed unless the hook reports READY in time."""
    record_frida_attach()
    try:
        proc = subprocess.Popen(
            frida_command(pid, script_path),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE, text=True, bufsize=1,
        )
    except OSError as exc:
        raise FridaError("FRIDA_ATTACH_FAILED", "Frida could not start") from exc
    try:
        lines = read_lines_until(proc, FRIDA_READY_TIMEOUT, stop_on="READY")
        if any("Failed to attach" in line or "Unable to attach" in line for line in lines):
            raise FridaError("FRIDA_ATTACH_FAILED", "Frida attach failed")
        if not any("READY" in line for line in lines):
            raise FridaError("FRIDA_ATTACH_TIMEOUT", "Frida hook readiness timed out")
    except FridaError:
        kill_frida(proc)
        raise
    except (OSError, ValueError) as exc:
        kill_frida(proc)
        raise FridaError("FRIDA_ATTACH_FAILED", "Frida readiness check failed") from exc
    return proc


def kill_frida(proc):
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()


def enumerate_sessions(pid, profile):
    """Find manager via vtable, read live vector + current selection.

    Manager-anchored approach: finds the live manager object via its vtable
    pointer (heap scan), then reads the session vector directly from the
    controller. This is immune to stale session data after re-login.

    Returns (dict of {username: index}, vector_base_hex, vector_count, current_sel_username|None).
    """
    username_off = profile["USERNAME_OFF"]
    elem_size = profile["ELEM_SIZE"]
    manager_vt_off = profile["MANAGER_VT_OFF"]
    ctrl_off = profile["CTRL_OFF"]
    cur_sess_off = profile["CUR_SESS_OFF"]
    cur_sess_uname_off = profile["CUR_SESS_UNAME_OFF"]
    vec_key_off = profile["VEC_KEY_OFF"]
    vec_map_off = profile.get("VEC_MAP_OFF")  # x86_64 only

    # Manager validation: check "normal_key" string at VEC_KEY_OFF.
    # On x86_64 multiple managers share the same vtable; this picks the right one.
    validate_js = f'var k = readStdString(hit.address.add(0x{vec_key_off:x})); if (k !== "normal_key") return;'

    # Architecture-specific vector access
    if vec_map_off is not None:
        # x86_64: walk unordered_map linked list to find "normal_key" vector
        vec_access_js = f"""
    // x86_64: walk unordered_map linked list to find "normal_key" vector
    // Layout: ctrl+0x{vec_map_off:x} → inner → inner+0x18 = hashmap
    //   hashmap+0x10 = first node; each node: next(+0), hash(+8), key(+0x10), value(+0x28)
    var hmInner = ctrl.add(0x{vec_map_off:x}).readPointer();
    var hmNode = hmInner.add(0x18 + 0x10).readPointer();
    var vectorBegin = ptr(0), vectorEnd = ptr(0);
    for (var _i = 0; _i < 20 && hmNode && !hmNode.isNull(); _i++) {{
        var nodeKey = readStdString(hmNode.add(0x10));
        if (nodeKey === "normal_key") {{
            vectorBegin = hmNode.add(0x28).readPointer();
            vectorEnd = hmNode.add(0x30).readPointer();
            break;
        }}
        hmNode = hmNode.readPointer();
    }}
"""
    else:
        # aarch64: vector directly at controller+0x0/0x8
        vec_access_js = """
    // aarch64: vector directly at controller+0x0/0x8
    var vectorBegin = ctrl.add(0x0).readPointer();
    var vectorEnd = ctrl.add(0x8).readPointer();
"""

    write_js("/tmp/_cs_enum.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var UNAME_OFF = 0x{username_off:x};
var ELEM_SZ = {elem_size};
var MANAGER_VT = b.add(0x{manager_vt_off:x});
var CTRL_OFF = 0x{ctrl_off:x};
var CUR_SESS_OFF = 0x{cur_sess_off:x};
var CUR_SESS_UNAME = 0x{cur_sess_uname_off:x};
{READ_STD_STRING_JS}

function ptrToPattern(p) {{
    var buf = Memory.alloc(8);
    buf.writePointer(p);
    var hex = [];
    for (var i = 0; i < 8; i++) hex.push(("0" + buf.add(i).readU8().toString(16)).slice(-2));
    return hex.join(" ");
}}

// Step 1: Find manager via vtable scan
var vtPattern = ptrToPattern(MANAGER_VT);
var manager = null;

Process.enumerateRanges("rw-").forEach(function(range) {{
    if (manager || range.size > 200*1024*1024) return;
    try {{
        Memory.scanSync(range.base, range.size, vtPattern).forEach(function(hit) {{
            if (manager) return;
            try {{
                var ctrl = hit.address.add(CTRL_OFF).readPointer();
                if (!ctrl.isNull() && ctrl.compare(ptr(0x10000)) >= 0) {{
                    {validate_js}
                    manager = hit.address;
                }}
            }} catch(e) {{}}
        }});
    }} catch(e) {{}}
}});

if (!manager) {{
    console.log("ERROR: manager not found via vtable scan");
    console.log("SCRIPT_DONE");
}} else {{
    console.log("MANAGER " + manager);

    // Step 2: Get vector begin/end
    var ctrl = manager.add(CTRL_OFF).readPointer();
{vec_access_js}
    if (vectorBegin.isNull() || vectorEnd.isNull() || vectorEnd.compare(vectorBegin) <= 0) {{
        console.log("ERROR: invalid vector pointers begin=" + vectorBegin + " end=" + vectorEnd);
        console.log("SCRIPT_DONE");
    }} else {{
        var count = vectorEnd.sub(vectorBegin).toInt32() / ELEM_SZ;
        console.log("VECTOR " + vectorBegin + " count=" + count);

        // Step 3: Enumerate sessions
        for (var i = 0; i < count; i++) {{
            try {{
                var ep = vectorBegin.add(i * ELEM_SZ).readPointer();
                if (ep.isNull() || ep.compare(ptr(0x10000)) < 0) continue;
                var u = readStdString(ep.add(UNAME_OFF));
                if (u) console.log("SESSION " + i + " " + u);
            }} catch(e) {{}}
        }}

        // Step 4: Read current selection
        var curSelName = "NONE";
        try {{
            var curPtr = ctrl.add(CUR_SESS_OFF).readPointer();
            if (!curPtr.isNull() && curPtr.compare(ptr(0x10000)) >= 0) {{
                var s = readStdString(curPtr.add(CUR_SESS_UNAME));
                if (s) curSelName = s;
            }}
        }} catch(e) {{}}
        console.log("CURRENT_SEL " + curSelName);

        console.log("SCRIPT_DONE");
    }}
}}
""")

    for attempt in range(MAX_ENUM_ATTEMPTS):
        if attempt > 0:
            log(f"[chat-select] Enumerate retry {attempt}...")
            time.sleep(2)
        log(f"[chat-select] Running Frida enumerate script (attempt {attempt})...")
        lines = run_frida_script(pid, "/tmp/_cs_enum.js")
        # Parse raw sessions from Frida output (raw vector index -> username)
        raw_sessions = []  # [(raw_index, username), ...] in vector order
        vector_base = None
        vector_count = 0
        current_sel = None
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("VECTOR "):
                parts = stripped.split()
                vector_base = parts[1]
                vector_count = int(parts[2].split("=")[1])
            elif stripped.startswith("CURRENT_SEL "):
                sel = stripped.split(None, 1)[1]
                if sel not in ("NONE",):
                    current_sel = sel
            elif stripped.startswith("SESSION"):
                parts = stripped.split(None, 2)
                if len(parts) >= 3:
                    raw_sessions.append((int(parts[1]), parts[2]))

        if raw_sessions:
            raw_sessions.sort(key=lambda x: x[0])

            gh_count = sum(1 for _, u in raw_sessions if is_official_account(u))
            log(f"[chat-select] Raw vector sessions={len(raw_sessions)} official_accounts={gh_count} count={vector_count}")

            # Build filtered index: skip official accounts, re-number from 0
            # selectSession() uses indices that exclude official accounts
            sessions = {}
            filtered_idx = 0
            for _, uname in raw_sessions:
                if is_official_account(uname):
                    continue
                sessions[uname] = filtered_idx
                filtered_idx += 1

            if current_sel:
                log("[chat-select] Current selection identity available=true")

            log(f"[chat-select] Filtered sessions={len(sessions)} excluded_official={gh_count}")

            return sessions, vector_base, vector_count, current_sel
    return {}, None, 0, None


def select_by_index(pid, profile, target_index, click_coords, vector_base, vector_count):
    """Hook selectSession, click, hook replaces index. Returns True on success."""
    select_session = profile["SELECT_SESSION"]
    username_off = profile["USERNAME_OFF"]
    elem_size = profile["ELEM_SIZE"]
    # Register that holds the index argument: x1 on aarch64, rsi on x86_64
    reg = "x1" if profile.get("ARCH") == "aarch64" else "rsi"

    log("[chat-select] Preparing bounded selection hook")

    write_js("/tmp/_cs_select.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var addr = b.add(0x{select_session:x});
var TARGET = {target_index};
var UNAME_OFF = 0x{username_off:x};
var ELEM_SZ = {elem_size};
var VECTOR_BASE = ptr("{vector_base}");
var VECTOR_COUNT = {vector_count};

{READ_STD_STRING_JS}

// Read username at RAW vector index
function readRawUsername(rawIdx) {{
    try {{
        if (rawIdx < 0 || rawIdx >= VECTOR_COUNT) return "<oob:" + rawIdx + "/" + VECTOR_COUNT + ">";
        var ep = VECTOR_BASE.add(rawIdx * ELEM_SZ).readPointer();
        if (ep.isNull()) return "<null>";
        var u = readStdString(ep.add(UNAME_OFF));
        return u || "<unreadable>";
    }} catch(e) {{
        return "<err:" + e + ">";
    }}
}}

// Map filtered index (excluding gh_ accounts) to username
function readFilteredUsername(filteredIdx) {{
    var fi = 0;
    for (var ri = 0; ri < VECTOR_COUNT; ri++) {{
        try {{
            var ep = VECTOR_BASE.add(ri * ELEM_SZ).readPointer();
            if (ep.isNull()) continue;
            var u = readStdString(ep.add(UNAME_OFF));
            if (!u) continue;
            if (/^gh_[0-9a-f]+$/.test(u)) continue;  // skip official accounts
            if (fi === filteredIdx) return u + " (raw=" + ri + ")";
            fi++;
        }} catch(e) {{}}
    }}
    return "<oob-filtered:" + filteredIdx + ">";
}}

console.log("READY");

var hook = Interceptor.attach(addr, {{
    onEnter: function(args) {{
        var orig = args[1].toInt32();
        console.log("REDIRECT");
        args[1] = ptr(TARGET);
        this.context.{reg} = TARGET;
    }},
    onLeave: function(retval) {{
        // Detach after selectSession returns so the prologue is restored
        // while no thread is inside the function.
        hook.detach();
        console.log("DETACHED");
    }}
}});
""")

    proc = run_frida_bg(pid, "/tmp/_cs_select.js")
    lines = []
    try:
        # The interceptor must always be detached, including click spawn/timeout
        # failures, or it could redirect a later manual click.
        cx, cy = click_coords
        log("[chat-select] Clicking verified chat-list target")
        try:
            click_result = subprocess.run(
                ["/opt/tools/click", str(cx), str(cy)],
                timeout=5,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise FridaError("CHAT_CLICK_TIMEOUT", "Chat-list click timed out") from exc
        except OSError as exc:
            raise FridaError("CHAT_CLICK_FAILED", "Chat-list click failed") from exc
        if click_result.returncode != 0:
            raise FridaError("CHAT_CLICK_FAILED", "Chat-list click failed")
        log("[chat-select] Click completed")

        # Read output looking for DETACHED confirmation (hook fires once then
        # detaches). Bounded read: if the click did not produce a selectSession
        # call the hook never fires and we give up after the deadline.
        lines = read_lines_until(proc, FRIDA_HOOK_TIMEOUT, stop_on="DETACHED")
    finally:
        kill_frida(proc)

    redirected = any("REDIRECT" in line for line in lines)
    if not redirected:
        log("[chat-select] Selection hook did not redirect")
    return redirected


def main():
    # Parse args: chat-select [--force] [--verify-only] [--click-xy X Y] <username>
    args = sys.argv[1:]
    if not args:
        fail("INVALID_ARGUMENT", "Invalid chat-select arguments")

    force = False
    verify_only = False
    click_xy = None
    positional = []

    i = 0
    while i < len(args):
        if args[i] == "--force":
            force = True
            i += 1
        elif args[i] == "--verify-only":
            verify_only = True
            i += 1
        elif args[i] == "--click-xy":
            if i + 2 >= len(args):
                fail("INVALID_ARGUMENT", "Invalid click coordinates")
            try:
                x = int(args[i + 1])
                y = int(args[i + 2])
            except ValueError:
                fail("INVALID_ARGUMENT", "Invalid click coordinates")
            if not (0 <= x <= 32767 and 0 <= y <= 32767):
                fail("INVALID_ARGUMENT", "Invalid click coordinates")
            click_xy = (x, y)
            i += 3
        else:
            positional.append(args[i])
            i += 1

    if not positional:
        fail("INVALID_ARGUMENT", "Invalid chat-select arguments")

    pid = get_pid()
    if not pid:
        fail("WECHAT_NOT_RUNNING", "WeChat is not running")
    log("[chat-select] WeChat process found")

    profile, err = get_profile(pid)
    if not profile:
        fail("UNSUPPORTED_WECHAT_BUILD", "WeChat build is not supported")

    # Enumerate sessions
    log("[chat-select] Enumerating sessions...")
    try:
        sessions, vector_base, vector_count, current_sel = enumerate_sessions(pid, profile)
    except FridaError as exc:
        fail(exc.code, str(exc))
    if not sessions:
        fail("FRIDA_ENUMERATION_FAILED", "Live chat identity could not be enumerated")

    # --list mode
    if positional[0] == "--list":
        result_json(True, sessions=sessions)

    target = positional[0]
    if is_official_account(target):
        fail("OFFICIAL_ACCOUNT_UNSUPPORTED", "Official accounts cannot be opened")
    if target not in sessions:
        fail("TARGET_NOT_FOUND", "Target was not found in the live session list")

    target_index = sessions[target]
    log("[chat-select] Exact target found in live session list")

    if verify_only:
        if current_sel == target:
            result_json(True, username=target, index=target_index, skipped=True, verified=True)
        log("[chat-select] Current conversation does not match target (identities redacted)")
        fail("TARGET_NOT_ACTIVE", "Target conversation is not active", verified=False)

    # Already-selected short-circuit: if the target chat is ALREADY the current
    # selection, the right-hand pane is already showing it — there is nothing
    # to do. This holds even when force=True: clicking the already-selected
    # chat list item does NOT trigger a selectSession() call, so the Frida
    # hook never fires and select_by_index() would wait out its deadline and
    # report a false "Hook did not fire" failure. current_sel is freshly read
    # from WeChat's current-session pointer on every invocation, so there is
    # no stale skip decision for force to override.
    if current_sel == target:
        log("[chat-select] Exact target already selected")
        result_json(True, username=target, index=target_index, skipped=True, verified=True)

    # Find click coordinates: use --click-xy if provided, else fall back to a11y
    click_coords = click_xy
    if not click_coords:
        click_coords = find_chat_item_from_a11y()
    if not click_coords:
        fail("A11Y_CLICK_TARGET_UNAVAILABLE", "No live chat-list click target is available")

    # Hook and click
    if not vector_base:
        fail("FRIDA_SESSION_VECTOR_UNAVAILABLE", "Live session vector is unavailable")
    try:
        ok = select_by_index(pid, profile, target_index, click_coords, vector_base, vector_count)
    except FridaError as exc:
        fail(exc.code, str(exc))
    if not ok:
        fail("FRIDA_HOOK_FAILED", "Frida selection hook did not complete")

    # The hook firing only proves that WeChat handled a selection call. Re-read
    # the live current-session pointer and require an exact target match before
    # allowing callers to type or send anything.
    try:
        _, _, _, confirmed_sel = enumerate_sessions(pid, profile)
    except FridaError as exc:
        fail(exc.code, str(exc), verified=False)
    if confirmed_sel != target:
        log("[chat-select] Target confirmation failed after selection (identities redacted)")
        fail("TARGET_CONFIRMATION_FAILED", "Target conversation could not be confirmed", verified=False)

    result_json(True, username=target, index=target_index, skipped=False, verified=True)


if __name__ == "__main__":
    try:
        main()
    except FridaError as exc:
        fail(exc.code, str(exc))
    except (OSError, subprocess.SubprocessError):
        fail("CHAT_SELECT_TOOL_FAILED", "Chat selection tool failed")
