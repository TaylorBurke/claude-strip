# Claude Strip

A thin status strip at the top of every terminal window running Claude Code, so
you can tell your agents apart when several run side by side:

```
● native-cards · fixing OTA asset paths · 3 tools running
```

The dot is accent-colored while the agent works, muted when idle, and urgent
red when it is waiting on a permission prompt.

It has two halves that talk through a small state file per session:

| Part | Where | Job |
| --- | --- | --- |
| `claude-mod/` | Claude Code mod (`session-strip`) | Publishes project, task and running-tool count for each session |
| `omarchy-plugin/` | Omarchy shell plugin (`taylorburke.claude-strip`) | Draws a strip over each matching terminal window |

The strip is terminal-agnostic: each session is matched to its Hyprland window
by walking the process tree, so foot, Alacritty, kitty and ghostty all work.
It is a 36px header in the theme's background color with a thin divider line
below it, drawn over the top of the window, so it covers the first one or two
terminal rows.

## Install

Requires Omarchy (Hyprland + Quickshell shell), Python 3, and Claude Code.

1. The Omarchy plugin:

   ```sh
   omarchy plugin add https://github.com/TaylorBurke/claude-strip --enable
   ```

2. The Claude Code mod, typed at a Claude Code prompt:

   ```
   /plugin install session-strip --marketplace TaylorBurke/claude-strip
   ```

## Uninstall

```sh
omarchy plugin remove taylorburke.claude-strip
claude plugin uninstall session-strip
rm -rf "$XDG_RUNTIME_DIR/claude-strip"    # optional: leftover state files
```

Neither half edits your shell, Hyprland or terminal configuration. The plugin
only adds itself to the plugin list in `shell.json` when you enable it.

## Configuration

Mod options (Claude Code config menu):

- **Summarize the task with Haiku** (default on). After turn 1 and then every N
  turns, one Haiku call through your session's own client rewrites the title
  (8-14 words, naming the concrete feature or bug). It sends the project name,
  the last four prompts (each cut to 300 characters) and the start of the
  assistant's latest reply (500 characters), and costs about $0.001. Off: the
  title is the first prompt, truncated.
- **Re-summarize every N turns** (default 3).

The strip's size lives at the top of `omarchy-plugin/Service.qml`:
`fontSize` (25, 2.5x a 10pt terminal), `stripHeight` (36), `padding` and
`borderSize`. Long titles are elided on the right in narrow windows.

## How it works

The mod writes `$XDG_RUNTIME_DIR/claude-strip/<claude-pid>.json` on prompt,
tool, permission and turn events. `scan.py` joins those files with
`hyprctl clients`, places each session relative to its monitor, and deletes
files whose process has died. `Service.qml` re-runs it on every Hyprland event
and once a second, and draws one click-through layer-shell strip per session.

## Dependencies and privileges

Plugins run unsandboxed with your user permissions, so for transparency:

- **Runs:** `python3 -I omarchy-plugin/scan.py` once a second and on Hyprland
  events, which in turn runs `hyprctl clients -j` and `hyprctl monitors -j`.
- **Reads:** `/proc/<pid>/stat` (to walk parent processes) and the state files
  in `$XDG_RUNTIME_DIR/claude-strip/`.
- **Writes/deletes:** only state files in that directory, and only stale ones
  (dead process or ended session). The mod writes them; the plugin deletes them.
- **Network:** none from the plugin. The mod's optional Haiku call goes through
  Claude Code's own client, like any other turn.
- **No root, no installers, no second Quickshell process.**
- **Removal:** disable or remove the plugin and the strips disappear at once;
  `rm -r $XDG_RUNTIME_DIR/claude-strip` clears leftover state (it is also wiped
  on logout).

## Known limits

- **Waiting state clears late.** Claude Code has no event for the moment you
  approve a permission prompt, so the red "waiting for you" state clears when
  the approved tool finishes.
- **Hyprland only.** Window lookup uses `hyprctl`.
- **Window-per-session.** Tabs and multiplexers (tmux panes) share one window,
  so only one session per window is shown.

## Development

```sh
claude plugin test claude-mod                       # mod tests
(cd omarchy-plugin && python3 -m unittest -q test_scan)
claude plugin validate .                            # mod + marketplace
omarchy plugin validate .                           # Omarchy manifest
```

## License

MIT
