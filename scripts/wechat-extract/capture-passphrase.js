var w = Process.getModuleByName("wechat");
var b = w.base;
var captured = false;
var seen = {};
var HOOKS = {{HOOKS}};

function looksKey(buf) {
    if (!buf || buf.byteLength !== 32) return false;
    var u8 = new Uint8Array(buf);
    var nz = 0, uniq = {};
    for (var i = 0; i < 32; i++) {
        if (u8[i] !== 0) nz++;
        uniq[u8[i]] = 1;
    }
    return nz >= 16 && Object.keys(uniq).length >= 8;
}

function emit(buf, src) {
    if (captured || !buf || buf.byteLength !== 32) return;
    if (!looksKey(buf)) return;
    var u8 = new Uint8Array(buf);
    var sig = "";
    for (var i = 0; i < 8; i++) sig += ("0" + u8[i].toString(16)).slice(-2);
    if (seen[sig]) return;
    seen[sig] = 1;
    send({tag: "cand", src: src}, buf);
}

function tryPtr32(p, src) {
    if (captured || !p || p.isNull()) return;
    try { emit(p.readByteArray(32), src); } catch (e) {}
}

function tryData(p, src) {
    if (captured || !p || p.isNull()) return;
    try {
        var sz = Number(p.add(16).readU64());
        var dp = p.add(8).readPointer();
        send({tag: "data", src: src, sz: sz});
        if (sz === 32) tryPtr32(dp, src + ":*(+8)");
    } catch (e) {}
    tryPtr32(p, src + ":direct32");
}

function hook(name, off) {
    try {
        Interceptor.attach(b.add(off), {
            onEnter: function(args) {
                var n = 0;
                try { n = args[2].toInt32(); } catch (e) {}
                send({tag: "hit", site: name, n: n});
                if (n === 32) tryPtr32(args[1], name + ":arg1n32");
                tryData(args[1], name + ":arg1");
                tryData(args[2], name + ":arg2");
            }
        });
        send({tag: "hooked", site: name, off: off.toString()});
    } catch (e) {
        send({tag: "hook_fail", site: name, err: String(e)});
    }
}

rpc.exports = {
    markCaptured: function() { captured = true; }
};

HOOKS.forEach(function(h) {
    hook(h.name, ptr(h.off));
});
send({tag: "ready", hooked: HOOKS.length});
