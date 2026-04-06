# Workspace v2

`workspace-v2` is a separate popup launcher for daily workspace switching. It does not replace the current GTK panel yet, and it does not modify the existing `workspace-switcher` behavior.

## What it solves

- Removes the need to keep the GTK side panel visible all day
- Keeps the same tmux and SSH model already used by the current workspace switcher
- Gives you a keyboard-first popup that appears only when you need to switch
- Keeps the old GTK switcher intact as fallback while v2 is evaluated

## Current behavior

The launcher:

- reads `~/ai-workflow/workspace-switcher/workspaces.json`
- shows workspaces in a temporary popup with live filtering
- displays host and active/offline state
- prefers recently used workspaces when the search is empty
- tries to focus an existing terminal window first
- otherwise launches the configured terminal and attaches/creates the matching tmux session

The current GTK switcher is untouched.

## Usage

Run the popup directly:

```bash
./workspace-v2/scripts/wsv2
```

Explicit popup subcommand:

```bash
./workspace-v2/scripts/wsv2 popup
```

List workspaces and status from a shell:

```bash
./workspace-v2/scripts/wsv2 list
```

Open one workspace directly:

```bash
./workspace-v2/scripts/wsv2 open vm9:dbtools
./workspace-v2/scripts/wsv2 open mysql
```

Kill a session:

```bash
./workspace-v2/scripts/wsv2 kill vm9:dbtools
```

## KDE Shortcut

Bind a global shortcut to:

```bash
/home/cslog/ai-workflow/workspace-v2/scripts/wsv2 popup
```

Suggested flow:

1. Press a shortcut such as `Meta+Space`
2. Type part of the workspace name, host, or path
3. Press `Enter`
4. The popup closes immediately and your target workspace is focused or launched

That makes the launcher temporary instead of always occupying screen space.

## Troubleshooting

If `popup` says there is no active display, that shell is not attached to a GUI session. This is common inside SSH/tmux shells on remote VMs.

In that case:

- run `popup` from a terminal that belongs to your KDE/XFCE desktop session
- or keep using the non-GUI commands:

```bash
./workspace-v2/scripts/wsv2 list
./workspace-v2/scripts/wsv2 open <target>
```

If the shell should have GUI access but tmux dropped the display variables, refresh tmux's GUI environment from a GUI terminal attached to the same tmux server, then retry.

## Notes

- The popup launcher solves the daily UI annoyance problem first.
- It does not yet remove `10.1.0.10` as a control-plane dependency. That remains separate phase-2 work.
- Recent workspace ordering is stored in `~/.local/state/ai-workflow/workspace-v2.json`.

## Verification

Run the lightweight tests with:

```bash
PYTHONPATH=workspace-v2/src python3 -m unittest discover -s workspace-v2/tests
```
