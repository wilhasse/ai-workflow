# Dashboard View-Selector Redesign — Design

**Date:** 2026-05-31
**Status:** Approved (design); pending implementation plan

## Summary

The desktop dashboard header has accumulated four independently-toggling
buttons (Terminals/Transcripts, Organize/Terminal, Jump, Grid/Single) plus
mic/refresh. These look like peers but represent three nested layers of state,
each appearing/disappearing based on the others, with labels that flip on click.
It is confusing, and the Grid mode only works on screens ≥1280px.

This redesign collapses the mutually-exclusive **view modes** into a single
**View ▾ dropdown** (Terminal / Organizer / Transcripts), drops the Grid mode
entirely, defaults the dashboard to the Terminal view, and keeps Jump/mic/refresh
as plain action icons. Desktop only — the mobile bottom-nav model is untouched.

## Decisions (locked during brainstorming)

- **Keep these view modes:** Single Terminal, Organizer, Transcripts.
- **Drop Grid** (`overviewMode`) entirely, including its state, button, render
  branch, grid-only controls, and localStorage keys.
- **Single selector** as a **dropdown** (`View: <current> ▾`), not a segmented
  control.
- **Default view = `terminal`** (previously the dashboard opened to the
  Organizer).
- **Jump / mic / refresh** stay as separate action icons (they are actions, not
  view modes). Shown in Terminal/Organizer, hidden in Transcripts.
- **Workspace cards** shown in Terminal/Organizer, hidden in Transcripts (already
  implemented).
- **Desktop only.** Mobile (`MobileTerminalApp` / `MobileLayout` / bottom-nav
  sheets) is out of scope; no Transcripts on mobile.
- **No backend changes.**

## State model

Replace three view-state variables with one:

| Removed | Replaced by |
|---|---|
| `mainView` (`'terminals' \| 'transcripts'`) | `view` (`'terminal' \| 'organizer' \| 'transcripts'`) |
| `desktopView` (`'organizer' \| 'terminal'`) | (folded into `view`) |
| `overviewMode` (boolean) | (removed; Grid dropped) |

- Initial value: read `?view=` query param. `organizer` and `transcripts` are
  honored; anything else (including absent) → `terminal`.
- Persistence: keep the existing URL-sync effect, generalized — set
  `?view=organizer` or `?view=transcripts`, and **remove** the param when
  `view === 'terminal'` (the default). This preserves deep-linking and the
  browser-tab isolation the app already relies on.

## Components

### New: `terminal-dashboard/src/components/layout/ViewSelector.jsx`

A small, self-contained dropdown.

- **Props:** `value` (current view string), `onChange(view)`, and `options`
  (array of `{ value, label }`). Passing `options` keeps the component dumb and
  lets `App.jsx` decide what is available.
- **Behavior:** a button showing `View: <active label> ▾`. Clicking toggles an
  open menu listing the options, each with a ✓ on the active one. Selecting an
  option calls `onChange` and closes. Closes on outside-click and on `Escape`.
- **No app state inside** — purely controlled. This is the one new unit; it has a
  single responsibility (pick a view), a clear interface (`value`/`onChange`/
  `options`), and no dependency on the rest of `App.jsx`.

### Modified: `terminal-dashboard/src/App.jsx`

1. Replace the `mainView` / `desktopView` / `overviewMode` state with the single
   `view` state and its generalized URL-sync effect.
2. Remove all Grid/overview code:
   - state: `overviewMode`, `overviewColumns`, `overviewHiddenIds`,
     `overviewHiddenSet`, `overviewFilterOpen`, derived `canUseOverview`,
     `overviewReadOnly`, `overviewFontSize`, and the `visibleWorkspaces`
     filtering that exists only for the grid.
   - storage keys: `OVERVIEW_COLUMNS_STORAGE_KEY`, `OVERVIEW_HIDDEN_STORAGE_KEY`
     and their load/save logic.
   - render: the `workspace-overview` grid branch inside `renderTerminalView()`,
     so that function only renders the single-workspace view.
   - the mic button's `overviewReadOnly` disabled/title conditions (simplify to
     not reference overview).
3. Header layout:
   - Place `<ViewSelector>` where the toggle buttons were.
   - Keep Jump/mic/refresh as icon buttons, rendered only when
     `view !== 'transcripts'`.
   - Render the workspace cards (header-center) only when `view !== 'transcripts'`.
4. `app-main` render becomes:
   ```jsx
   {view === 'transcripts' ? (
     <TranscriptsView active />
   ) : view === 'organizer' ? (
     <TerminalOrganizer ... />
   ) : (
     renderTerminalView()
   )}
   ```

### Modified: `terminal-dashboard/src/App.css`

- Add styles for `ViewSelector` (button + dropdown menu + active check).
- Remove now-unused `workspace-overview*` / overview grid styles.

## Render matrix (after redesign)

| `view` | Header center | Action icons | `app-main` |
|---|---|---|---|
| `terminal` | workspace cards | Jump, mic, refresh | single-workspace terminal |
| `organizer` | workspace cards | Jump, mic, refresh | `TerminalOrganizer` |
| `transcripts` | hidden | hidden | `TranscriptsView` |

`ViewSelector` is always visible in the desktop header in every mode.

## Scope guards

- The desktop header (and thus `ViewSelector`) is only rendered when not mobile —
  `DashboardApp` returns `<MobileLayout>` earlier when `isMobile`, and the
  `/mobile` route renders `MobileTerminalApp`. Neither path is touched.
- Removing `overviewMode` must not break the `isMobile`/`MobileLayout` branch:
  verify no mobile code path references the removed overview state.

## Error handling / edge cases

- Unknown `?view=` value → falls back to `terminal` (no crash, no blank screen).
- Switching to `organizer`/`transcripts` and back to `terminal` cleanly
  adds/removes the URL param.
- Removing overview state must also remove every reference to it; a missed
  reference would be a build/lint error (caught by `npm run build` / `npm run
  lint`).

## Testing

No test framework is configured for `terminal-dashboard` (per its conventions).
Verification:

1. `npm run lint` — clean.
2. `npm run build` — succeeds (a dangling reference to removed overview state
   would fail here).
3. Manual click-through after a container rebuild:
   - Dashboard opens to **Terminal** view by default.
   - `View ▾` lists Terminal / Organizer / Transcripts; selecting each switches
     `app-main` correctly; ✓ marks the active one.
   - In **Transcripts**, workspace cards and Jump/mic/refresh are hidden; only
     `View ▾` remains.
   - In **Terminal**/**Organizer**, cards and action icons return; terminals and
     the organizer work as before.
   - No Grid button anywhere; resizing the window never reveals one.
   - `?view=organizer` and `?view=transcripts` deep-link correctly; `terminal`
     shows no `view` param.
   - Mobile (`/mobile` and narrow viewport) is unchanged.

## Out of scope

- Mobile redesign / Transcripts on mobile.
- Any change to the Jump switcher, voice, or organizer internals beyond
  visibility gating.
- Backend / service changes.
