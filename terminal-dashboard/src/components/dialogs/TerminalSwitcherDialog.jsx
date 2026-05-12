import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const formatRelativeTime = (timestamp) => {
  if (!timestamp) {
    return 'never used'
  }

  const diffMs = Date.now() - timestamp
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000))
  if (diffMinutes < 1) {
    return 'just now'
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

const statusLabels = {
  check: 'Check',
  idle: 'Idle',
}

const sectionKeyForEntry = (entry) => {
  if (entry.status === 'check') return 'check'
  return entry.label ? 'labeled' : 'other'
}

const sectionLabelForEntry = (entry) => {
  if (entry.status === 'check') return 'Needs check'
  return entry.label ? 'Labeled tabs' : 'Other active tabs'
}

const nextStatusForEntry = (entry) => {
  if (entry.status === 'check') return 'idle'
  if (entry.status === 'idle') return ''
  return 'check'
}

const SHORTCUT_HELP = '↑↓ Navigate · Enter Open · Alt+L Label · Alt+C Check · Alt+I Idle · Alt+A Active'

function TerminalSwitcherDialog({
  isOpen,
  onClose,
  entries,
  loading,
  query,
  preferredEntryId,
  onQueryChange,
  onSelectEntry,
  onRenameEntry,
  onStatusChange,
}) {
  const inputRef = useRef(null)
  const highlightedItemRef = useRef(null)
  const selectedEntryIdRef = useRef(null)
  const manualSelectionRef = useRef(false)
  const preferredSelectionAppliedRef = useRef(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const selectedEntry = entries[highlightedIndex] ?? null
  const hasEntries = entries.length > 0

  const rememberSelection = useCallback((entry) => {
    manualSelectionRef.current = true
    selectedEntryIdRef.current = entry?.id ?? null
  }, [])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    setHighlightedIndex(0)
    manualSelectionRef.current = false
    preferredSelectionAppliedRef.current = false
    selectedEntryIdRef.current = null
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    if (!entries.length) {
      selectedEntryIdRef.current = null
      setHighlightedIndex(0)
      return
    }

    const shouldApplyPreferred = !manualSelectionRef.current &&
      !preferredSelectionAppliedRef.current &&
      !query.trim() &&
      preferredEntryId
    const selectedEntryId = shouldApplyPreferred
      ? preferredEntryId
      : selectedEntryIdRef.current
    if (selectedEntryId) {
      const nextIndex = entries.findIndex((entry) => entry.id === selectedEntryId)
      if (nextIndex >= 0) {
        if (shouldApplyPreferred) {
          preferredSelectionAppliedRef.current = true
        }
        selectedEntryIdRef.current = selectedEntryId
        setHighlightedIndex(nextIndex)
        return
      }
    }

    setHighlightedIndex((previousIndex) => {
      const nextIndex = Math.min(previousIndex, entries.length - 1)
      selectedEntryIdRef.current = entries[nextIndex]?.id ?? null
      return nextIndex
    })
  }, [entries, isOpen, preferredEntryId, query])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    highlightedItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (!hasEntries) {
        return
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && selectedEntry) {
        const key = event.key.toLowerCase()
        if (key === 'l') {
          event.preventDefault()
          rememberSelection(selectedEntry)
          onRenameEntry(selectedEntry)
          return
        }
        if (onStatusChange && key === 'c') {
          event.preventDefault()
          rememberSelection(selectedEntry)
          onStatusChange(selectedEntry, 'check')
          return
        }
        if (onStatusChange && key === 'i') {
          event.preventDefault()
          rememberSelection(selectedEntry)
          onStatusChange(selectedEntry, 'idle')
          return
        }
        if (onStatusChange && key === 'a') {
          event.preventDefault()
          rememberSelection(selectedEntry)
          onStatusChange(selectedEntry, '')
          return
        }
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedIndex((prev) => {
          const nextIndex = (prev + 1) % entries.length
          manualSelectionRef.current = true
          selectedEntryIdRef.current = entries[nextIndex]?.id ?? null
          return nextIndex
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedIndex((prev) => {
          const nextIndex = (prev - 1 + entries.length) % entries.length
          manualSelectionRef.current = true
          selectedEntryIdRef.current = entries[nextIndex]?.id ?? null
          return nextIndex
        })
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        if (selectedEntry) {
          onSelectEntry(selectedEntry)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [entries, hasEntries, isOpen, onClose, onRenameEntry, onSelectEntry, onStatusChange, rememberSelection, selectedEntry])

  const footerText = useMemo(() => {
    if (!hasEntries) {
      return 'Type to filter by workspace name, task, or tmux tab number.'
    }
    return `${entries.length} tabs shown. Ctrl+Enter opens this switcher.`
  }, [entries.length, hasEntries])

  if (!isOpen) {
    return null
  }

  return (
    <div className="dialog-overlay terminal-switcher-overlay" onClick={onClose}>
      <div className="terminal-switcher-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="terminal-switcher-header">
          <div>
            <h3 className="dialog-title">Terminal Switcher</h3>
            <p className="terminal-switcher-subtitle">Jump by workspace and tmux tab description</p>
          </div>
          <span className="terminal-switcher-shortcut">Ctrl+Enter</span>
        </div>

        <div className="terminal-switcher-help">{SHORTCUT_HELP}</div>

        <input
          ref={inputRef}
          type="text"
          className="terminal-switcher-search"
          placeholder="Search workspace, task, or #tab number"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />

        <div className="terminal-switcher-list">
          {loading ? (
            <div className="terminal-switcher-empty">Loading tmux tabs…</div>
          ) : !hasEntries ? (
            <div className="terminal-switcher-empty">No matching tabs found.</div>
          ) : (
            entries.map((entry, index) => (
              <Fragment key={entry.id}>
                {(index === 0 || sectionKeyForEntry(entries[index - 1]) !== sectionKeyForEntry(entry)) && (
                  <div className="terminal-switcher-section">
                    {sectionLabelForEntry(entry)}
                  </div>
                )}
                <div
                  ref={index === highlightedIndex ? highlightedItemRef : null}
                  className={`terminal-switcher-item ${index === highlightedIndex ? 'active' : ''}`}
                  onMouseEnter={() => {
                    manualSelectionRef.current = true
                    selectedEntryIdRef.current = entry.id
                    setHighlightedIndex(index)
                  }}
                >
                  <button
                    type="button"
                    className="terminal-switcher-item-main"
                    onClick={() => onSelectEntry(entry)}
                  >
                    <div className="terminal-switcher-item-title">
                      <span className="terminal-switcher-tab-label">{entry.windowName}</span>
                      <span className="terminal-switcher-separator">·</span>
                      <span className="terminal-switcher-window-index">#{entry.windowIndex}</span>
                      {entry.status && (
                        <span className={`terminal-status-badge ${entry.status}`}>
                          {statusLabels[entry.status] || entry.status}
                        </span>
                      )}
                      <span className="terminal-switcher-workspace-name">{entry.workspaceName}</span>
                    </div>
                    <div className="terminal-switcher-item-meta">
                      {entry.hostName ? `${entry.hostName} · ` : ''}
                      {entry.label ? `tmux ${entry.tmuxName} · ` : ''}
                      {entry.workspaceDescription ? `${entry.workspaceDescription} · ` : ''}
                      {entry.windowActive ? 'active tab' : 'background tab'} · recent {formatRelativeTime(entry.recentAt)} · selected {entry.useCount}x
                    </div>
                  </button>
                  <div className="terminal-switcher-actions">
                    <button
                      type="button"
                      className="terminal-switcher-rename"
                      onClick={(event) => {
                        event.stopPropagation()
                        rememberSelection(entry)
                        onRenameEntry(entry)
                      }}
                    >
                      Label
                    </button>
                    {onStatusChange && (
                      <button
                        type="button"
                        className={`terminal-switcher-status ${entry.status || 'active'}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          rememberSelection(entry)
                          onStatusChange(entry, nextStatusForEntry(entry))
                        }}
                      >
                        {statusLabels[entry.status] || 'Flag'}
                      </button>
                    )}
                  </div>
                </div>
              </Fragment>
            ))
          )}
        </div>

        <div className="terminal-switcher-footer">{footerText}</div>
      </div>
    </div>
  )
}

export default TerminalSwitcherDialog
