#!/usr/bin/env python3
"""Offer to install the session-strip Claude Code mod, which the strip needs.

  mod_setup.py check    asks (once a week at most) when the mod is missing
  mod_setup.py install  installs it

Nothing is installed without a click on the notification that `check` shows.
"""
import os
import shutil
import subprocess
import sys
import time

MARKETPLACE = "TaylorBurke/claude-strip"
PLUGIN = "session-strip@claude-strip"
ASK_EVERY = 7 * 24 * 3600
STATE_HOME = os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state"))
MARKER = os.path.join(STATE_HOME, "claude-strip", "mod-prompted")


def run(args, timeout):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def mod_installed():
    return PLUGIN in run(["claude", "plugin", "list"], 30).stdout


def asked_recently(now):
    try:
        return now - os.path.getmtime(MARKER) < ASK_EVERY
    except OSError:
        return False


def notify(body, actions=False):
    cmd = ["notify-send", "-a", "Claude Strip", "-t", "30000"]
    if actions:
        cmd += ["-w", "-A", "default=Install"]
    cmd += ["Claude Strip", body]
    return subprocess.run(cmd, capture_output=True, text=True, check=False).stdout.strip()


def check():
    if shutil.which("claude") is None or shutil.which("notify-send") is None:
        return
    now = time.time()
    if asked_recently(now) or mod_installed():
        return
    os.makedirs(os.path.dirname(MARKER), exist_ok=True)
    with open(MARKER, "w"):
        pass
    answer = notify("The strip needs the session-strip Claude Code mod. Click to install it.", actions=True)
    if answer == "default":
        install()


def install():
    steps = [["claude", "plugin", "marketplace", "add", MARKETPLACE], ["claude", "plugin", "install", PLUGIN]]
    for step in steps:
        done = run(step, 120)
        # An already-added marketplace is fine; anything else that fails stops here.
        if done.returncode != 0 and "already" not in (done.stdout + done.stderr).lower():
            notify("Could not install the session-strip mod. Run: claude plugin install " + PLUGIN)
            return
    notify("session-strip mod installed. Run /reload-plugins in open Claude Code sessions, or restart them.")


if __name__ == "__main__":
    {"check": check, "install": install}[sys.argv[1]]()
