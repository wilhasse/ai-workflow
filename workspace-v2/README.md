# Workspace v2

`workspace-v2` is a separate popup launcher for daily workspace switching. It does not replace the current GTK panel yet, and it does not modify the existing `workspace-switcher` behavior.

## What it solves

- Removes the need to keep the GTK side panel visible all day
- Keeps the same tmux and SSH model already used by the current workspace switcher
- Gives you a keyboard-first popup that appears only when you need to switch
- Keeps the old GTK switcher intact as fallback while v2 is evaluated
- Adds a canonical host-explicit catalog so phase 2 no longer depends on ambiguous `local`

## Current behavior

The launcher now prefers the canonical v2 catalog at:

```bash
/home/cslog/ai-workflow/workspace-v2/catalog/workspaces.v2.json
```

If that file is missing, it falls back to the legacy GTK catalog at:

```bash
~/ai-workflow/workspace-switcher/workspaces.json
```

The launcher:

- resolves a self host at runtime and decides when to use local tmux versus SSH
- still reads the legacy catalog when needed, so the old GTK switcher is untouched
- shows workspaces in a temporary popup with live filtering
- displays host and active/offline state
- prefers recently used workspaces when the search is empty
- tries to focus an existing terminal window first
- otherwise launches the configured terminal and attaches/creates the matching tmux session

## Canonical host model

Phase `16.1` introduces an explicit-host v2 catalog.

Key ideas:

- `local` is no longer the canonical host id in v2
- every workspace belongs to an explicit host such as `vm10`, `vm9`, or `vm12`
- the tool resolves which host is "self" at runtime, then treats that host as local tmux execution
- other hosts are reached by SSH

Self-host resolution order:

1. `WSV2_SELF_HOST` environment variable if set
2. host identity matching from the current machine hostname against catalog host metadata
3. if neither resolves, all explicit hosts are treated as remote

In the bundled catalog:

- `vm10` maps to `10.1.0.10`
- `vm9` maps to `10.1.0.9`
- `vm12` maps to `10.1.0.12`

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
./workspace-v2/scripts/wsv2 open vm10:mysql
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

If runtime self-host detection picks the wrong machine, set it explicitly:

```bash
export WSV2_SELF_HOST=vm10
```

## Notes

- The popup launcher solves the daily UI annoyance problem first.
- Phase `16.1` is now about removing the ambiguous `local` host assumption from the v2 path.
- It does not yet remove `10.1.0.10` as a control-plane dependency by itself; the non-GUI fallback launcher and outage drill remain later phase-2 work.
- Recent workspace ordering is stored in `~/.local/state/ai-workflow/workspace-v2.json`.

## Verification

Run the lightweight tests with:

```bash
PYTHONPATH=workspace-v2/src python3 -m unittest discover -s workspace-v2/tests
```
