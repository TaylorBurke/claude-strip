#!/usr/bin/env python3
"""Join Claude Code session state files with Hyprland windows.

Reads $XDG_RUNTIME_DIR/claude-strip/<pid>.json (written by the session-strip
Claude Code mod), finds the Hyprland window whose process is an ancestor of
that pid, and prints a JSON array of sessions placed relative to their monitor.
Stale files (dead pid, or session ended) are deleted.
"""
import glob
import json
import os
import subprocess

STATE_DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "claude-strip")


def hypr(what):
    return json.loads(subprocess.check_output(["hyprctl", what, "-j"], timeout=3))


def parent_of(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def window_for(pid, clients_by_pid):
    seen = 0
    while pid > 1 and seen < 64:
        if pid in clients_by_pid:
            return clients_by_pid[pid]
        pid = parent_of(pid)
        seen += 1
    return None


def main():
    files = glob.glob(os.path.join(STATE_DIR, "*.json"))
    if not files:
        print("[]")
        return

    clients = hypr("clients")
    monitors = {m["id"]: m for m in hypr("monitors")}
    visible = set()
    for m in monitors.values():
        visible.add(m["activeWorkspace"]["id"])
        special = m.get("specialWorkspace", {}).get("id", 0)
        if special:
            visible.add(special)
    clients_by_pid = {c["pid"]: c for c in clients if c.get("mapped") and not c.get("hidden")}

    out = []
    for path in files:
        try:
            with open(path) as f:
                s = json.load(f)
            pid = int(s["pid"])
        except (OSError, ValueError, KeyError):
            continue
        if not os.path.exists(f"/proc/{pid}") or s.get("phase") == "ended":
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        win = window_for(pid, clients_by_pid)
        mon = monitors.get(win["monitor"]) if win else None
        if not win or not mon or win["workspace"]["id"] not in visible:
            continue
        s.update(
            address=win["address"],
            monitor=mon["name"],
            x=win["at"][0] - mon["x"],
            y=win["at"][1] - mon["y"],
            w=win["size"][0],
            h=win["size"][1],
        )
        out.append(s)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
