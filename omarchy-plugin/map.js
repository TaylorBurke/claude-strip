// Which strips changed session id since last time. A /clear gives a running Claude process a new
// session id without any other sign, so the strip notices it and has roundhouse move the map it
// shows from the old session to the new one (`roundhouse rebind OLD NEW`).
//   known: { pid: sid } as of the last scan;  sessions: the scan's sessions, each with pid and sid ("" if none)
//   missing: { pid: scans in a row it was absent } (optional)
// A strip missing from a scan (off-screen workspace, id briefly absent) keeps its remembered id, so a
// /clear while it is away is still seen when it comes back; after `keepScans` scans away it is forgotten,
// so a dead process's pid reused later is not mistaken for it.
// Returns { pairs: [[old, new], ...], known: the new { pid: sid }, missing: the new { pid: count } }.
var keepScans = 300;
function rebinds(known, sessions, missing) {
    var pairs = [], seen = {}, absent = {}, now = {};
    sessions.forEach(function (s) {
        if (s.sid) now[s.pid] = s.sid;
    });
    Object.keys(known).forEach(function (pid) {
        if (now[pid]) return;
        var n = ((missing || {})[pid] || 0) + 1;
        if (n <= keepScans) { seen[pid] = known[pid]; absent[pid] = n; }
    });
    Object.keys(now).forEach(function (pid) {
        var before = known[pid];
        if (before && before !== now[pid]) pairs.push([before, now[pid]]);
        seen[pid] = now[pid];
    });
    return { pairs: pairs, known: seen, missing: absent };
}

if (typeof module !== "undefined") module.exports = { rebinds: rebinds, keepScans: keepScans };
