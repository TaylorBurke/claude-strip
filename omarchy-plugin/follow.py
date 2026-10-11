#!/usr/bin/env python3
"""Make a window follow the cursor while a strip is being dragged.

Usage: follow.py <window-address>

Runs until it reads a line on stdin or stdin closes (the strip writes one when
the mouse is released); SIGTERM also stops it.
The window follows the cursor; a tiled one floats while held and is tiled
again when the script is stopped, so it lands where the cursor is.
It prints the window's real geometry ("x y w h", global) on every tick.
Talks to Hyprland's socket directly so each tick costs no process spawn.
"""
import json
import os
import select
import signal
import socket
import sys
import time

TICK = 0.016
SETTLE = 0.5  # seconds to keep reporting after the drop
STATE_DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "claude-strip")


def request(command):
    sig = os.environ["HYPRLAND_INSTANCE_SIGNATURE"]
    path = os.path.join(os.environ["XDG_RUNTIME_DIR"], "hypr", sig, ".socket.sock")
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(2)
        s.connect(path)
        s.sendall(command.encode())
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
    return b"".join(chunks).decode()


def hypr(what):
    return json.loads(request(f"j/{what}"))


def dispatch(call):
    request(f"dispatch {call}")


def window_at(clients, x, y, skip, workspaces):
    """The tiled, visible window under (x, y), ignoring the dragged one."""
    for c in clients:
        if c["address"] == skip or c.get("floating") or not c.get("mapped") or c.get("hidden"):
            continue
        if c["workspace"]["id"] not in workspaces:
            continue
        left, top = c["at"]
        width, height = c["size"]
        if left <= x < left + width and top <= y < top + height:
            return c
    return None


def emit(address):
    """Print the window's real geometry (global x y w h) so the strip can track it exactly."""
    me = next((c for c in hypr("clients") if c["address"] == address), None)
    if me:
        print(me["at"][0], me["at"][1], me["size"][0], me["size"][1], flush=True)
    return me


def marker_path(address):
    return os.path.join(STATE_DIR, f"drag-{address}.pending")


def finish(address, tiled):
    if tiled:
        retile(address)
        # Keep reporting while the window animates into its tile.
        end = time.monotonic() + SETTLE
        while time.monotonic() < end:
            emit(address)
            time.sleep(TICK)
        try:
            os.unlink(marker_path(address))
        except OSError:
            pass
    sys.exit(0)


def main(address):
    clients = hypr("clients")
    me = next((c for c in clients if c["address"] == address), None)
    if me is None:
        return
    tiled = not me.get("floating")
    signal.signal(signal.SIGTERM, lambda *_: finish(address, tiled))
    if tiled:
        # Like Hyprland's own drag: the window floats while held, then is re-tiled
        # where it is dropped. The marker lets scan.py re-tile it if this script dies
        # before it can (see recover_drags there).
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(marker_path(address), "w") as f:
            f.write(str(os.getpid()))
        dispatch(f'hl.dsp.window.float({{ action = "enable", window = "address:{address}" }})')
        # Floating shrinks a window to a default size; keep the tile's size and place.
        w, h = me["size"]
        dispatch(f'hl.dsp.window.resize({{ x = {w}, y = {h}, window = "address:{address}" }})')
        dispatch(f'hl.dsp.window.move({{ x = {me["at"][0]}, y = {me["at"][1]}, window = "address:{address}" }})')
        me = next((c for c in hypr("clients") if c["address"] == address), me)
    cursor = hypr("cursorpos")
    # Keep the window at the same offset from the cursor.
    offset = (me["at"][0] - cursor["x"], me["at"][1] - cursor["y"])
    last = None
    while True:
        cursor = hypr("cursorpos")
        point = (cursor["x"], cursor["y"])
        if point != last:
            last = point
            x, y = point[0] + offset[0], point[1] + offset[1]
            dispatch(f'hl.dsp.window.move({{ x = {x}, y = {y}, window = "address:{address}" }})')
        if emit(address) is None:
            return
        # The strip ends the drag by writing a line to stdin (or closing it, which also
        # happens if the shell dies), which is steadier than relying on a signal.
        ready, _, _ = select.select([sys.stdin], [], [], TICK)
        if ready:
            sys.stdin.readline()
            finish(address, tiled)


def retile(address):
    """Tile the window again next to the tile under the cursor, on the side it was dropped."""
    cursor = hypr("cursorpos")
    clients = hypr("clients")
    me = next((c for c in clients if c["address"] == address), None)
    target = window_at(clients, cursor["x"], cursor["y"], address, {me["workspace"]["id"]}) if me else None
    if target:
        # New tiles split the focused window, so focus the drop target first. Focusing
        # warps the cursor to that window's centre; put it back afterwards.
        dispatch(f'hl.dsp.focus({{ window = "address:{target["address"]}" }})')
        dispatch(f'hl.dsp.cursor.move({{ x = {cursor["x"]}, y = {cursor["y"]} }})')
    dispatch(f'hl.dsp.window.float({{ action = "disable", window = "address:{address}" }})')
    if target:
        left, top = target["at"]
        width, height = target["size"]
        dx = (cursor["x"] - left) / width - 0.5
        dy = (cursor["y"] - top) / height - 0.5
        if abs(dx) * width >= abs(dy) * height:
            direction = "left" if dx < 0 else "right"
        else:
            direction = "up" if dy < 0 else "down"
        if direction in ("left", "up"):
            dispatch(f'hl.dsp.window.move({{ direction = "{direction}", window = "address:{address}" }})')


if __name__ == "__main__":
    main(sys.argv[1])
