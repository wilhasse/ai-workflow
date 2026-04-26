# Workspace v2

`workspace-v2` is a separate launcher path for daily workspace switching. It does not replace the current GTK panel yet, and it does not modify the existing `workspace-switcher` behavior.

## What it solves

- Removes the need to keep the GTK side panel visible all day
- Keeps the same tmux and SSH model already used by the current workspace switcher
- Gives you a keyboard-first popup that appears only when you need to switch
- Keeps the old GTK switcher intact as fallback while v2 is evaluated
- Adds a canonical host-explicit catalog so phase 2 no longer depends on ambiguous `local`
- Adds a non-GUI fallback launcher path for tmux and plain TTY usage

## Current behavior

The launcher now prefers the canonical v2 catalog at:

```bash
/home/cslog/ai-workflow/workspace-v2/catalog/workspaces.v2.json
```

If that file is missing, it falls back to the legacy GTK catalog at:

```bash
~/ai-workflow/workspace-switcher/workspaces.json
```

The launcher can now choose the best available surface automatically when you run:

```bash
./workspace-v2/scripts/wsv2 popup
```

Surface selection order:

1. GTK popup when `DISPLAY` or `WAYLAND_DISPLAY` is present
2. tmux popup when running inside tmux without a GUI display
3. inline TUI when running on a normal TTY without tmux

## Canonical host model

Phase `16.1` introduces an explicit-host v2 catalog.

Key ideas:

- `local` is no longer the canonical host id in v2
- every workspace belongs to an explicit host such as `vm10`, `vm9`, or `vm12`
- the tool resolves which host is `self` at runtime, then treats that host as local tmux execution
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

Best available popup surface:

```bash
./workspace-v2/scripts/wsv2 popup
```

Explicit GUI-only window launcher:

```bash
./workspace-v2/scripts/wsv2 open vm10:mysql
```

Attach or switch in the current shell / tmux client:

```bash
./workspace-v2/scripts/wsv2 attach vm9:dbtools
./workspace-v2/scripts/wsv2 attach mysql
```

Explicit tmux popup launcher:

```bash
./workspace-v2/scripts/wsv2 tmux-popup
```

Inline terminal selector:

```bash
./workspace-v2/scripts/wsv2 tui
```

List workspaces and status from a shell:

```bash
./workspace-v2/scripts/wsv2 list
```

Print the attach command for inspection:

```bash
./workspace-v2/scripts/wsv2 command vm9:dbtools
```

Kill a session:

```bash
./workspace-v2/scripts/wsv2 kill vm9:dbtools
```

## How 16.2 behaves

When you run from a tmux shell on a fallback host:

- `popup` opens a tmux popup selector instead of trying GTK
- selecting a workspace closes the selector and switches/attaches from the current pane
- for local-host workspaces inside tmux, the tool uses `tmux switch-client` rather than trying to nest tmux clients

That gives you a usable failover control surface without depending on the KDE desktop on `10.1.0.10`.

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

## Troubleshooting

If runtime self-host detection picks the wrong machine, set it explicitly:

```bash
export WSV2_SELF_HOST=vm10
```

If `popup` says it could not find a usable launcher surface, use one of:

```bash
./workspace-v2/scripts/wsv2 attach <target>
./workspace-v2/scripts/wsv2 list
```

## Notes

- The popup launcher solved the daily UI annoyance problem first.
- Phase `16.1` removed the ambiguous `local` host assumption from the v2 path.
- Phase `16.2` adds a non-GUI fallback path for tmux and TTY usage.
- Phase `16.3` adds first-class control-host bootstrap and sync/install helpers.
- Recent ordering uses the newer of tmux `window_activity` and launcher selection time. Launcher selection time is stored in `~/.local/state/ai-workflow/workspace-v2.json`.

## Phase 16.3 Control-Host Bootstrap

Phase `16.3` turns a machine into a first-class `workspace-v2` control host instead of just "a repo checkout that happens to exist".

What gets installed:

- `~/.local/bin/wsv2` wrapper
- `~/.config/workspace-v2/control-host.env` with `WSV2_SELF_HOST`, `WSV2_CONFIG_PATH`, and `WSV2_REPO_ROOT`

Bootstrap the current host:

```bash
/home/cslog/ai-workflow/workspace-v2/scripts/install-control-host.sh --host-id vm9
```

Sync and bootstrap another host:

```bash
/home/cslog/ai-workflow/workspace-v2/scripts/sync-control-host.sh --target cslog@10.1.0.10 --host-id vm10
```

After bootstrap, the operational entry point becomes simply:

```bash
wsv2 list
wsv2 popup
wsv2 attach vm9:dbtools
```

Minimal assumptions on a control host:

- `tmux` installed
- `ssh` installed
- repo present at the configured path
- correct `WSV2_SELF_HOST` for that machine
- access to `workspace-v2/catalog/workspaces.v2.json`

## Phase 16.4 Outage Drill

Phase `16.4` adds an explicit outage-validation helper instead of relying on manual interpretation of `list` output.

Run the drill from the fallback control host, for example on `vm9` while simulating `vm10` down:

```bash
/home/cslog/ai-workflow/workspace-v2/scripts/run-outage-drill.sh --control-host vm9 --down-host vm10
```

What it does:

- writes a temporary simulated config where the down host becomes unreachable
- loads the catalog as the chosen control host
- selects one healthy workspace per surviving host by default
- creates and removes short-lived probe tmux sessions to verify control actually works

Typical expected outcome for the current setup:

- `vm10`-hosted workspaces show as down in the snapshot
- `vm9` and `vm12` probe targets pass
- workspaces whose files truly live on `vm10` remain unavailable by design

You can also specify explicit targets:

```bash
/home/cslog/ai-workflow/workspace-v2/scripts/run-outage-drill.sh --control-host vm9 --down-host vm10 --target vm9:dbtools --target vm12:fusion
```

## Verification

Run the lightweight tests with:

```bash
PYTHONPATH=workspace-v2/src python3 -m unittest discover -s workspace-v2/tests
```
