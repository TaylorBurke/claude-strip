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
import re
import subprocess

STATE_DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "claude-strip")
CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))

# Where each terminal keeps its font size, and the size it uses when unset.
TERMINAL_CONFIGS = {
    "foot": ("foot/foot.ini", 10.0),
    "alacritty": ("alacritty/alacritty.toml", 11.25),
    "kitty": ("kitty/kitty.conf", 11.0),
    "ghostty": ("ghostty/config", 12.0),
}
DEFAULT_FONT_PT = 10.0


def hypr(what):
    return json.loads(subprocess.check_output(["hyprctl", what, "-j"], timeout=3))


def parent_of(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def parse_font_pt(terminal, text):
    """The font size in points a terminal's config sets, or None when it sets none."""
    number = r"([0-9]+(?:\.[0-9]+)?)"
    if terminal == "foot":
        match = re.search(r"^\s*font\s*=.*?:size=" + number, text, re.M)
    elif terminal == "alacritty":
        section, match = None, None
        for line in text.splitlines():
            head = re.match(r"^\s*\[([^\]]+)\]", line)
            if head:
                section = head.group(1).strip()
                continue
            if section in ("font", "font.normal"):
                match = re.match(r"^\s*size\s*=\s*" + number, line)
                if match and section == "font":
                    break
    elif terminal == "kitty":
        match = re.search(r"^\s*font_size\s+" + number, text, re.M)
    elif terminal == "ghostty":
        match = re.search(r"^\s*font-size\s*=\s*" + number, text, re.M)
    else:
        match = None
    return float(match.group(1)) if match else None


def terminal_font_pt(pid):
    """The font size of the terminal that owns this window's process."""
    try:
        terminal = os.path.basename(os.readlink(f"/proc/{pid}/exe")).lower()
    except OSError:
        return DEFAULT_FONT_PT
    entry = TERMINAL_CONFIGS.get(terminal)
    if entry is None:
        return DEFAULT_FONT_PT
    path, default = entry
    try:
        with open(os.path.join(CONFIG_HOME, path)) as f:
            return parse_font_pt(terminal, f.read()) or default
    except OSError:
        return default


def window_for(pid, clients_by_pid):
    seen = 0
    while pid > 1 and seen < 64:
        if pid in clients_by_pid:
            return clients_by_pid[pid]
        pid = parent_of(pid)
        seen += 1
    return None


def recover_drags():
    """Re-tile windows left floating by a strip drag whose follow.py died (see follow.py)."""
    for path in glob.glob(os.path.join(STATE_DIR, "drag-*.pending")):
        try:
            with open(path) as f:
                pid = int(f.read().strip())
        except (OSError, ValueError):
            pid = 0
        if pid and os.path.exists(f"/proc/{pid}"):
            continue
        address = os.path.basename(path)[len("drag-"):-len(".pending")]
        if re.fullmatch(r"0x[0-9a-f]+", address):
            call = f'hl.dsp.window.float({{ action = "disable", window = "address:{address}" }})'
            subprocess.run(["hyprctl", "dispatch", call], check=False, timeout=3, stdout=subprocess.DEVNULL)
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    recover_drags()
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
            mx=mon["x"],
            my=mon["y"],
            w=win["size"][0],
            h=win["size"][1],
            fontPt=terminal_font_pt(win["pid"]),
        )
        out.append(s)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
