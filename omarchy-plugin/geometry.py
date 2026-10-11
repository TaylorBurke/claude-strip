#!/usr/bin/env python3
"""Stream window geometry from Hyprland so the strips follow resizes closely.

Prints "<address> <x> <y> <w> <h>" (global coordinates) whenever a window's
geometry changes. After any Hyprland event it samples the windows every tick
until nothing has moved for SETTLE seconds, so a resize or an animation is
followed frame by frame; otherwise it looks every IDLE seconds.
Talks to Hyprland's sockets directly, so no tick costs a process spawn.
"""
import json
import os
import select
import socket
import sys
import time

TICK = 0.016
IDLE = 0.05  # asleep, still look this often: not every resize announces itself as an event
SETTLE = 0.4  # seconds without change before going back to sleep


def socket_path(name):
    sig = os.environ["HYPRLAND_INSTANCE_SIGNATURE"]
    return os.path.join(os.environ["XDG_RUNTIME_DIR"], "hypr", sig, name)


def clients():
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(2)
        s.connect(socket_path(".socket.sock"))
        s.sendall(b"j/clients")
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
    return json.loads(b"".join(chunks))


def geometry(all_clients):
    """address -> (x, y, w, h) for every mapped window."""
    return {c["address"]: (*c["at"], *c["size"]) for c in all_clients if c.get("mapped")}


def changes(previous, current):
    """The lines to print for windows whose geometry differs from the last sample."""
    return [f"{address} {x} {y} {w} {h}" for address, (x, y, w, h) in current.items()
            if previous.get(address) != (x, y, w, h)]


def main():
    events = socket.socket(socket.AF_UNIX)
    events.connect(socket_path(".socket2.sock"))
    seen = {}
    awake_until = time.monotonic() + SETTLE
    while True:
        now = time.monotonic()
        wait = TICK if now < awake_until else IDLE
        ready, _, _ = select.select([events], [], [], wait)
        if ready and not events.recv(65536):
            return  # Hyprland went away; the strip restarts this script
        current = geometry(clients())
        lines = changes(seen, current)
        seen = current
        if lines or ready:
            awake_until = time.monotonic() + SETTLE
        if lines:
            print("\n".join(lines), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError):
        sys.exit(1)
