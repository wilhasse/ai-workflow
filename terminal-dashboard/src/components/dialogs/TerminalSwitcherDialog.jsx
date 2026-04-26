import { useEffect, useMemo, useRef, useState } from 'react'

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

function TerminalSwitcherDialog({
  isOpen,
  onClose,
  entries,
  loading,
  query,
  onQueryChange,
  onSelectEntry,
  onRenameEntry,
}) {
  const inputRef = useRef(null)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const selectedEntry = entries[highlightedIndex] ?? null
  const hasEntries = entries.length > 0

  useEffect(() => {
    if (!isOpen) {
      return
    }
    setHighlightedIndex(0)
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isOpen])

  useEffect(() => {
    if (highlightedIndex < entries.length) {
      return
    }
    setHighlightedIndex(Math.max(entries.length - 1, 0))
  }, [entries.length, highlightedIndex])

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

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedIndex((prev) => (prev + 1) % entries.length)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedIndex((prev) => (prev - 1 + entries.length) % entries.length)
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
  }, [entries, hasEntries, isOpen, onClose, onSelectEntry, selectedEntry])

  const footerText = useMemo(() => {
    if (!hasEntries) {
      return 'Type to filter by workspace name, task, or tmux tab number.'
    }
    return 'Ctrl+Enter opens this switcher. Use ↑↓ to navigate and Enter to jump.'
  }, [hasEntries])

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
              <div
                key={entry.id}
                className={`terminal-switcher-item ${index === highlightedIndex ? 'active' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <button
                  type="button"
                  className="terminal-switcher-item-main"
                  onClick={() => onSelectEntry(entry)}
                >
                  <div className="terminal-switcher-item-title">
                    <span className="terminal-switcher-workspace">{entry.workspaceName}</span>
                    <span className="terminal-switcher-separator">·</span>
                    <span className="terminal-switcher-window-index">#{entry.windowIndex}</span>
                    <span className="terminal-switcher-window-name">{entry.windowName}</span>
                  </div>
                  <div className="terminal-switcher-item-meta">
                    {entry.workspaceDescription ? `${entry.workspaceDescription} · ` : ''}
                    {entry.windowActive ? 'active tab' : 'background tab'} · recent {formatRelativeTime(entry.recentAt)} · selected {entry.useCount}x
                  </div>
                </button>
                <button
                  type="button"
                  className="terminal-switcher-rename"
                  onClick={(event) => {
                    event.stopPropagation()
                    onRenameEntry(entry)
                  }}
                >
                  Rename
                </button>
              </div>
            ))
          )}
        </div>

        <div className="terminal-switcher-footer">{footerText}</div>
      </div>
    </div>
  )
}

export default TerminalSwitcherDialog
