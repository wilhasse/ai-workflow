# Dashboard View-Selector Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop dashboard's four shifting view-toggle buttons with a single `View ▾` dropdown (Terminal / Organizer / Transcripts), drop the Grid mode entirely, and default to the Terminal view.

**Architecture:** Collapse three React state variables (`mainView`, `desktopView`, `overviewMode`) in `terminal-dashboard/src/App.jsx` into one `view` state driven by a new controlled `ViewSelector` dropdown component. Remove all Grid/overview code. Desktop only; no backend changes.

**Tech Stack:** React (Vite), plain CSS. No test framework is configured for `terminal-dashboard` (per repo convention), so each task verifies with `npm run lint` + `npm run build` — a dangling reference to removed state fails the build — and the final task does a manual click-through after a container rebuild.

**Design doc:** `docs/superpowers/specs/2026-05-31-dashboard-view-selector-redesign-design.md`

---

## File Structure

- `terminal-dashboard/src/components/layout/ViewSelector.jsx` — NEW. Controlled dropdown: `value`, `onChange`, `options`. Single responsibility (pick a view), no app-state inside.
- `terminal-dashboard/src/App.jsx` — MODIFY. Remove Grid/overview code; consolidate `mainView`+`desktopView`+`overviewMode` → `view`; render `ViewSelector`; gate cards/action-icons by `view`.
- `terminal-dashboard/src/App.css` — MODIFY. Add `ViewSelector` styles; remove the now-dead `.workspace-overview*` block.

**Note on TDD:** there is no JS test runner in this project. "Verify it fails / passes" is done via `npm run build` and `npm run lint`, which mechanically catch references to deleted symbols and JSX errors. Manual verification (Task 5) covers behavior.

---

## Task 1: Create the `ViewSelector` dropdown component

**Files:**
- Create: `terminal-dashboard/src/components/layout/ViewSelector.jsx`

- [ ] **Step 1: Create the component**

Create `terminal-dashboard/src/components/layout/ViewSelector.jsx`:

```javascript
import { useEffect, useRef, useState } from 'react'

// Controlled view-mode dropdown. `options` is [{ value, label }]; `value` is the
// active option's value; `onChange(value)` fires on selection.
export default function ViewSelector({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeLabel = options.find((o) => o.value === value)?.label ?? value

  return (
    <div className="view-selector" ref={ref}>
      <button
        type="button"
        className="view-selector-trigger secondary"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch view"
      >
        View: {activeLabel} ▾
      </button>
      {open && (
        <ul className="view-selector-menu" role="listbox">
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className={`view-selector-option ${option.value === value ? 'active' : ''}`}
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="check">{option.value === value ? '✓' : ''}</span>
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it builds (import is added in Task 3; here just confirm syntax/lint)**

Run: `cd terminal-dashboard && npm run lint`
Expected: no errors reported for `ViewSelector.jsx`.

- [ ] **Step 3: Commit**

```bash
git add terminal-dashboard/src/components/layout/ViewSelector.jsx
git commit -m "feat: add ViewSelector dropdown component"
```

---

## Task 2: Remove the Grid / overview mode

All edits are in `terminal-dashboard/src/App.jsx` unless noted. Use the exact anchors below.

- [ ] **Step 1: Remove the overview storage-key constants**

Replace:
```javascript
const OVERVIEW_COLUMNS_STORAGE_KEY = 'terminal-dashboard-overview-columns'
const OVERVIEW_HIDDEN_STORAGE_KEY = 'terminal-dashboard-overview-hidden'
const WINDOW_USAGE_STORAGE_KEY = 'terminal-dashboard-window-usage'
```
with:
```javascript
const WINDOW_USAGE_STORAGE_KEY = 'terminal-dashboard-window-usage'
```

- [ ] **Step 2: Remove the overview numeric constants**

Replace:
```javascript
const DEFAULT_FONT_SIZE = 16
const OVERVIEW_MIN_FONT_SIZE = 12
const DEFAULT_OVERVIEW_COLUMNS = 3
const MIN_OVERVIEW_COLUMNS = 1
const MAX_OVERVIEW_COLUMNS = 6
const VOICE_SERVICES = {
```
with:
```javascript
const DEFAULT_FONT_SIZE = 16
const VOICE_SERVICES = {
```

- [ ] **Step 3: Remove `isLargeScreen` + `canUseOverview` and clean the import**

Replace:
```javascript
  const isMobile = useIsMobile()
  const isLargeScreen = useMediaQuery('(min-width: 1280px)')
  const canUseOverview = !isMobile && isLargeScreen
```
with:
```javascript
  const isMobile = useIsMobile()
```

Then replace the import:
```javascript
import { useIsMobile, useMediaQuery } from './hooks/useMediaQuery'
```
with:
```javascript
import { useIsMobile } from './hooks/useMediaQuery'
```

- [ ] **Step 4: Remove the overview state hooks**

Replace:
```javascript
  const [overviewMode, setOverviewMode] = useState(false)
  const [overviewColumns, setOverviewColumns] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_OVERVIEW_COLUMNS
    const stored = Number(window.localStorage.getItem(OVERVIEW_COLUMNS_STORAGE_KEY))
    if (Number.isFinite(stored)) {
      return Math.min(MAX_OVERVIEW_COLUMNS, Math.max(MIN_OVERVIEW_COLUMNS, stored))
    }
    return DEFAULT_OVERVIEW_COLUMNS
  })
  const [overviewHiddenIds, setOverviewHiddenIds] = useState(() => {
    if (typeof window === 'undefined') return []
    try {
      const stored = JSON.parse(window.localStorage.getItem(OVERVIEW_HIDDEN_STORAGE_KEY) || '[]')
      if (Array.isArray(stored)) {
        return stored
      }
    } catch {
      // ignore
    }
    return []
  })
  const [overviewFilterOpen, setOverviewFilterOpen] = useState(false)

  // Voice transcription state
```
with:
```javascript
  // Voice transcription state
```

- [ ] **Step 5: Remove the overview derived values (keep `activeWorkspaces`)**

Replace:
```javascript
  const overviewReadOnly = overviewMode && canUseOverview
  const selectedVoiceProviderUnavailable = voiceService === VOICE_SERVICES.DEEPGRAM &&
    voiceProviderStatus.checked &&
    !voiceProviderStatus.deepgramConfigured
  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.active),
    [workspaces],
  )
  const overviewHiddenSet = useMemo(
    () => new Set(overviewHiddenIds),
    [overviewHiddenIds],
  )
  const visibleWorkspaces = useMemo(
    () => activeWorkspaces.filter((workspace) => !overviewHiddenSet.has(workspace.id)),
    [activeWorkspaces, overviewHiddenSet],
  )
  const overviewFontSize = useMemo(() => {
    const reduction = Math.min(4, Math.max(2, overviewColumns - 2))
    return Math.max(OVERVIEW_MIN_FONT_SIZE, terminalFontSize - reduction)
  }, [overviewColumns, terminalFontSize])
```
with:
```javascript
  const selectedVoiceProviderUnavailable = voiceService === VOICE_SERVICES.DEEPGRAM &&
    voiceProviderStatus.checked &&
    !voiceProviderStatus.deepgramConfigured
  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.active),
    [workspaces],
  )
```

- [ ] **Step 6: Remove the overview effects**

Replace:
```javascript
  useEffect(() => {
    if (!canUseOverview && overviewMode) {
      setOverviewMode(false)
    }
  }, [canUseOverview, overviewMode])

  useEffect(() => {
    if (!overviewMode) {
      setOverviewFilterOpen(false)
    }
  }, [overviewMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(OVERVIEW_HIDDEN_STORAGE_KEY, JSON.stringify(overviewHiddenIds))
  }, [overviewHiddenIds])
```
with: (nothing — delete the whole block)

Then remove the columns-persistence effect. Replace:
```javascript
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(OVERVIEW_COLUMNS_STORAGE_KEY, String(overviewColumns))
  }, [overviewColumns])
```
with: (nothing — delete it)

- [ ] **Step 7: Fix the three voice consumers of `overviewReadOnly`**

In `trySendTranscriptToTerminal`, replace:
```javascript
    if (!trimmed) return false
    if (overviewReadOnly) {
      return false
    }
    const payload = `${trimmed}\n`
```
with:
```javascript
    if (!trimmed) return false
    const payload = `${trimmed}\n`
```

In `handleSendTranscriptToTerminal`, replace:
```javascript
    if (overviewReadOnly) {
      setVoiceError('Switch to single view to send input.')
      return
    }
    if (!terminalBridgeRef.current) {
```
with:
```javascript
    if (!terminalBridgeRef.current) {
```

In `handleMicToggle`, replace:
```javascript
      handleVoiceRecordingStart(!overviewReadOnly)
```
with:
```javascript
      handleVoiceRecordingStart(true)
```

- [ ] **Step 8: Fix the mobile `onStartRecording` consumer**

Replace:
```javascript
          onStartRecording={() => handleVoiceRecordingStart(!overviewReadOnly)}
```
with:
```javascript
          onStartRecording={() => handleVoiceRecordingStart(true)}
```

- [ ] **Step 9: Remove the grid branch from `renderTerminalView`**

The grid branch is the `if (overviewMode && canUseOverview) { ... }` block at the top of `renderTerminalView`. Delete from this line:
```javascript
  const renderTerminalView = () => {
    if (overviewMode && canUseOverview) {
```
through the block's closing `}` that immediately precedes the single-workspace `if (workspacesLoading) {`. After the edit, the function must read:
```javascript
  const renderTerminalView = () => {
    if (workspacesLoading) {
      return (
        <div className="empty-state">
          <p>Loading workspaces...</p>
        </div>
```
Practically: open the file, locate `const renderTerminalView = () => {`, and delete every line from the following `if (overviewMode && canUseOverview) {` up to and including the `}` that closes it (the line before `if (workspacesLoading) {`). The closing looks like:
```javascript
        </section>
      )
    }

    if (workspacesLoading) {
```
Keep `if (workspacesLoading) {` and everything after; remove the `</section> ) }` grid tail and everything above it back to the `if (overviewMode && canUseOverview) {`.

- [ ] **Step 10: Remove the Grid button and simplify the mic button**

Replace:
```javascript
              {canUseOverview && (
                <button
                  type="button"
                  className={`secondary overview-toggle ${overviewMode ? 'active' : ''}`}
                  onClick={() => setOverviewMode((prev) => !prev)}
                  title={overviewMode ? 'Switch to single workspace view' : 'Show all active workspaces'}
                >
                  {overviewMode ? 'Single' : 'Grid'}
                </button>
              )}
              <button
                type="button"
                className={`mic-toggle ${voiceRecording ? 'recording' : ''} ${voicePending ? 'pending' : ''}`}
                disabled={voicePending || !isSecureContext || overviewReadOnly || selectedVoiceProviderUnavailable}
                title={
                  overviewReadOnly
                    ? 'Switch to single view to send voice input'
                    : selectedVoiceProviderUnavailable
                      ? 'Deepgram is not configured on the server'
                    : voiceRecording
                      ? 'Stop recording'
                      : 'Start voice recording'
                }
              >
```
with:
```javascript
              <button
                type="button"
                className={`mic-toggle ${voiceRecording ? 'recording' : ''} ${voicePending ? 'pending' : ''}`}
                disabled={voicePending || !isSecureContext || selectedVoiceProviderUnavailable}
                title={
                  selectedVoiceProviderUnavailable
                    ? 'Deepgram is not configured on the server'
                    : voiceRecording
                      ? 'Stop recording'
                      : 'Start voice recording'
                }
              >
```

- [ ] **Step 11: Verify the build is clean (no dangling overview references)**

Run: `cd terminal-dashboard && npm run lint && npm run build`
Expected: lint clean; build succeeds. If lint/build reports `overviewMode`, `overviewReadOnly`, `canUseOverview`, `visibleWorkspaces`, `overviewColumns`, `overviewHiddenIds`, `overviewFontSize`, `overviewFilterOpen`, or `useMediaQuery` is not defined / unused, find and remove that leftover reference, then re-run.

- [ ] **Step 12: Commit**

```bash
git add terminal-dashboard/src/App.jsx
git commit -m "refactor: remove Grid/overview mode from dashboard"
```

---

## Task 3: Consolidate to a single `view` state + wire the dropdown

All edits in `terminal-dashboard/src/App.jsx`.

- [ ] **Step 1: Import `ViewSelector`**

After the existing import:
```javascript
import TranscriptsView from './components/transcripts/TranscriptsView'
```
add:
```javascript
import ViewSelector from './components/layout/ViewSelector'
```

- [ ] **Step 2: Replace `desktopView` + `mainView` state with one `view` state**

Replace:
```javascript
  const [desktopView, setDesktopView] = useState('organizer')
  const [mainView, setMainView] = useState(() => {
    if (typeof window === 'undefined') return 'terminals'
    return new URLSearchParams(window.location.search).get('view') === 'transcripts'
      ? 'transcripts'
      : 'terminals'
  })
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (mainView === 'transcripts') params.set('view', 'transcripts')
    else params.delete('view')
    const query = params.toString()
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`
    window.history.replaceState(null, '', next)
  }, [mainView])
```
with:
```javascript
  const [view, setView] = useState(() => {
    if (typeof window === 'undefined') return 'terminal'
    const param = new URLSearchParams(window.location.search).get('view')
    return param === 'organizer' || param === 'transcripts' ? param : 'terminal'
  })
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (view === 'terminal') params.delete('view')
    else params.set('view', view)
    const query = params.toString()
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`
    window.history.replaceState(null, '', next)
  }, [view])
```

- [ ] **Step 3: Fix the terminal-tabs effect that referenced `desktopView`**

Replace:
```javascript
    if (desktopView !== 'organizer' || isMobile) {
```
with:
```javascript
    if (view !== 'organizer' || isMobile) {
```
And update its dependency array — replace:
```javascript
  }, [desktopView, isMobile, loadTerminalTabs])
```
with:
```javascript
  }, [view, isMobile, loadTerminalTabs])
```

- [ ] **Step 4: Fix the Jump handler that switched to terminal view**

Replace:
```javascript
    setDesktopView('terminal')
```
with:
```javascript
    setView('terminal')
```

- [ ] **Step 5: Replace the header view-toggle buttons with `ViewSelector`**

Replace this block (the Transcripts toggle + the opening of the terminal-only group + the Organize/Terminal button):
```javascript
          {mainView === 'terminals' && (
            <div className="workspace-cards">
```
Wait — first handle the header-center cards gate. Replace:
```javascript
        <div className="header-center">
          {mainView === 'terminals' && (
            <div className="workspace-cards">
```
with:
```javascript
        <div className="header-center">
          {view !== 'transcripts' && (
            <div className="workspace-cards">
```

- [ ] **Step 6: Replace the header-right toggle cluster**

Replace:
```javascript
          <button
            type="button"
            className={`secondary switcher-btn ${mainView === 'transcripts' ? 'active' : ''}`}
            onClick={() => setMainView((v) => (v === 'transcripts' ? 'terminals' : 'transcripts'))}
            title="Switch between terminals and YouTube transcripts"
          >
            {mainView === 'transcripts' ? 'Terminals' : 'Transcripts'}
          </button>
          {mainView === 'terminals' && (
            <>
              <button
                type="button"
                className={`secondary switcher-btn ${desktopView === 'organizer' ? 'active' : ''}`}
                onClick={() => setDesktopView((view) => (view === 'organizer' ? 'terminal' : 'organizer'))}
                title="Organize tmux tab labels"
              >
                {desktopView === 'organizer' ? 'Terminal' : 'Organize'}
              </button>
              <button
                type="button"
                className="secondary switcher-btn"
                onClick={openTerminalSwitcher}
                title="Jump between terminals and tmux tabs (Ctrl+Enter)"
              >
                Jump
              </button>
```
with:
```javascript
          <ViewSelector
            value={view}
            onChange={setView}
            options={[
              { value: 'terminal', label: 'Terminal' },
              { value: 'organizer', label: 'Organizer' },
              { value: 'transcripts', label: 'Transcripts' },
            ]}
          />
          {view !== 'transcripts' && (
            <>
              <button
                type="button"
                className="secondary switcher-btn"
                onClick={openTerminalSwitcher}
                title="Jump between terminals and tmux tabs (Ctrl+Enter)"
              >
                Jump
              </button>
```

(The closing `</>` and `)}` for this group, plus the mic/refresh buttons inside it, are unchanged from Task 2.)

- [ ] **Step 7: Update the `app-main` render to the 3-way `view` switch**

Replace:
```javascript
        {mainView === 'transcripts' ? (
          <TranscriptsView active={mainView === 'transcripts'} />
        ) : desktopView === 'organizer' ? (
          <TerminalOrganizer
            tabs={terminalTabs}
            loading={terminalTabsLoading}
            errors={terminalTabErrors}
            saving={Boolean(terminalLabelSavingId)}
            onRefresh={loadTerminalTabs}
            onSaveLabels={handleSaveTerminalLabels}
          />
        ) : renderTerminalView()}
```
with:
```javascript
        {view === 'transcripts' ? (
          <TranscriptsView active />
        ) : view === 'organizer' ? (
          <TerminalOrganizer
            tabs={terminalTabs}
            loading={terminalTabsLoading}
            errors={terminalTabErrors}
            saving={Boolean(terminalLabelSavingId)}
            onRefresh={loadTerminalTabs}
            onSaveLabels={handleSaveTerminalLabels}
          />
        ) : renderTerminalView()}
```

- [ ] **Step 8: Verify build + lint (catches any leftover `mainView`/`desktopView`)**

Run: `cd terminal-dashboard && npm run lint && npm run build`
Expected: lint clean; build succeeds. If anything still references `mainView` or `desktopView`, fix it (replace with `view`/`setView` using the same semantics) and re-run.

Confirm none remain:
Run: `grep -nE "mainView|desktopView|overviewMode|overviewReadOnly|canUseOverview" terminal-dashboard/src/App.jsx`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add terminal-dashboard/src/App.jsx
git commit -m "feat: consolidate dashboard view controls into a single View dropdown"
```

---

## Task 4: Styles — add `ViewSelector`, remove dead overview CSS

**Files:**
- Modify: `terminal-dashboard/src/App.css`

- [ ] **Step 1: Append `ViewSelector` styles**

Append to `terminal-dashboard/src/App.css`:

```css
/* View selector dropdown */
.view-selector { position: relative; display: inline-block; }
.view-selector-trigger { white-space: nowrap; }
.view-selector-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 50;
  min-width: 160px;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--color-bg-tertiary, #1e1e1e);
  border: 1px solid var(--color-border-medium, rgba(255,255,255,0.15));
  border-radius: var(--radius-sm, 6px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
}
.view-selector-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.45rem 0.6rem;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.view-selector-option:hover { background: rgba(255,255,255,0.08); }
.view-selector-option.active { font-weight: 600; }
.view-selector-option .check { width: 1em; display: inline-block; }
```

- [ ] **Step 2: Remove the dead overview CSS block**

The contiguous overview block runs from the rule `.workspace-overview {` to the rule `.workspace-overview-card .terminal-frame { ... }`, immediately before the `/* Terminal Font Control */` comment. Delete that whole block.

Find the start and end line numbers:
Run: `grep -n "^\.workspace-overview {" terminal-dashboard/src/App.css ; grep -n "/\* Terminal Font Control \*/" terminal-dashboard/src/App.css`

Delete from the `.workspace-overview {` line up to (but NOT including) the `/* Terminal Font Control */` line. For example, if they are lines 2770 and 2969:
Run: `sed -i '2770,2968d' terminal-dashboard/src/App.css`
(Use the actual numbers from the grep; the end line is the blank line just before the `/* Terminal Font Control */` comment.)

Leave the small `.workspace-overview-card-status` rules near line 1311 — they are harmless and intermixed with shared status styles; removing them is not worth the risk.

- [ ] **Step 3: Verify build**

Run: `cd terminal-dashboard && npm run build`
Expected: build succeeds; CSS bundle smaller than before.

- [ ] **Step 4: Commit**

```bash
git add terminal-dashboard/src/App.css
git commit -m "style: add ViewSelector styles and drop dead overview CSS"
```

---

## Task 5: Deploy and verify

- [ ] **Step 1: Rebuild the dashboard container**

Run: `cd /home/cslog/ai-workflow && ./rebuild-stack.sh terminal-dashboard`
Expected: `ai-workflow-dashboard` recreated; stack healthy.

- [ ] **Step 2: Manual click-through (hard-refresh the browser first)**

Open `https://10.1.0.10:8448` and verify:
- Dashboard opens on the **Terminal** view by default (a terminal, not the organizer); URL has no `view` param.
- The header shows a single **`View: Terminal ▾`** dropdown (no Organize/Terminal, no Jump-vs-Grid clutter). Jump 🔍, mic 🎙, refresh ↻ icons are present.
- Opening `View ▾` lists **Terminal / Organizer / Transcripts** with ✓ on the active one.
- Selecting **Organizer** → shows the tmux-label organizer; URL `?view=organizer`; cards + action icons still present.
- Selecting **Transcripts** → shows the transcripts view; workspace cards and Jump/mic/refresh are hidden; only `View ▾` remains; URL `?view=transcripts`.
- Selecting **Terminal** → back to a single terminal; clicking a workspace card shows its terminal.
- **No Grid button** appears at any window width (resize wide and narrow to confirm).
- Visit `https://10.1.0.10:8448/?view=organizer` and `/?view=transcripts` directly → each deep-links to the right view.
- Mobile unchanged: open `/mobile` (or a narrow viewport) → bottom-nav (Terminals/Projects/Voice/More) works as before.

- [ ] **Step 3: Update the repo overview**

In `CLAUDE.md`, update the `terminal-dashboard` bullet to describe the single **View** dropdown (Terminal / Organizer / Transcripts) instead of the old Terminals/Transcripts toggle, and note that the Grid/overview mode was removed.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: dashboard now uses a single View selector"
```

---

## Self-Review Notes

- **Spec coverage:** single `view` state (Task 3), `ViewSelector` dropdown (Task 1, wired Task 3), default `terminal` (Task 3 Step 2), Grid removal incl. state/consts/effects/render/consumers (Task 2), action-icon + card gating by `view` (Task 3 Steps 5–6, mic in Task 2 Step 10), `app-main` 3-way (Task 3 Step 7), deep-link `?view=` generalized (Task 3 Step 2), dead CSS removal + new styles (Task 4), desktop-only/mobile-untouched (Task 2 Step 8 fixes the only mobile consumer to behavior-preserving `true`; verified Task 5), manual verification (Task 5). No backend changes.
- **Name consistency:** `view` / `setView` and the option values `terminal` / `organizer` / `transcripts` are used identically across Tasks 1, 3, 5. `ViewSelector` props `value` / `onChange` / `options` match between component (Task 1) and usage (Task 3 Step 6). All removed symbols (`mainView`, `desktopView`, `overviewMode`, `overviewReadOnly`, `canUseOverview`, `visibleWorkspaces`, `overviewColumns`, `overviewHiddenIds`, `overviewFilterOpen`, `overviewFontSize`, `useMediaQuery`, `isLargeScreen`) are verified absent by the grep in Task 3 Step 8 and the build in Task 2 Step 11.
- **No placeholders:** every code/command step has concrete content; the two line-number-dependent deletes (Task 2 Step 9, Task 4 Step 2) give exact anchor text and a grep to find current numbers.
