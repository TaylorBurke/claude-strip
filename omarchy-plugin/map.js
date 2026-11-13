// Which strips changed session id since last time. A /clear gives a running Claude process a new
// session id without any other sign, so the strip notices it and has roundhouse move the map it
// shows from the old session to the new one (`roundhouse rebind OLD NEW`).
//   known: { pid: sid } as of the last scan;  sessions: the scan's sessions, each with pid and sid ("" if none)
// Returns { pairs: [[old, new], ...], known: the new { pid: sid } }.
function rebinds(known, sessions) {
    var pairs = [], seen = {};
    sessions.forEach(function (s) {
        if (!s.sid) return;
        seen[s.pid] = s.sid;
        var before = known[s.pid];
        if (before && before !== s.sid) pairs.push([before, s.sid]);
    });
    return { pairs: pairs, known: seen };
}

if (typeof module !== "undefined") module.exports = { rebinds: rebinds };
