import { useEffect, useMemo, useState } from 'react'

const formatRelativeTime = (timestamp) => {
  if (!timestamp) {
    return 'never'
  }

  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
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
  return `${Math.floor(diffHours / 24)}d ago`
}

function TerminalLabelRow({ tab, saving, onSaveLabel }) {
  const [draft, setDraft] = useState(tab.label || '')
  const currentLabel = tab.label || ''
  const changed = draft.trim() !== currentLabel

  useEffect(() => {
    setDraft(tab.label || '')
  }, [tab.label])

  return (
    <form
      className="terminal-organizer-row"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !saving) {
          onSaveLabel(tab, draft)
        }
      }}
    >
      <div className="terminal-organizer-tab">
        <span className="terminal-organizer-index">#{tab.windowIndex}</span>
        <div>
          <strong>{tab.displayName}</strong>
          <small>
            tmux: {tab.tmuxName}
            {tab.windowActive ? ' · active' : ''}
            {' · '}
            {formatRelativeTime(tab.recentAt)}
          </small>
        </div>
      </div>
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Short label"
        maxLength={80}
        aria-label={`Label for ${tab.workspaceName} window ${tab.windowIndex}`}
      />
      <div className="terminal-organizer-actions">
        <button type="submit" className="secondary" disabled={!changed || saving}>
          {saving ? 'Saving' : 'Save'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!currentLabel || saving}
          onClick={() => {
            setDraft('')
            onSaveLabel(tab, '')
          }}
        >
          Clear
        </button>
      </div>
    </form>
  )
}

function TerminalOrganizer({
  tabs = [],
  loading,
  errors = [],
  savingId,
  onRefresh,
  onSaveLabel,
}) {
  const groups = useMemo(() => {
    const hosts = new Map()
    tabs.forEach((tab) => {
      if (!hosts.has(tab.hostId)) {
        hosts.set(tab.hostId, {
          id: tab.hostId,
          name: tab.hostName,
          workspaces: new Map(),
        })
      }
      const host = hosts.get(tab.hostId)
      const workspaceKey = `${tab.hostId}:${tab.sessionId}`
      if (!host.workspaces.has(workspaceKey)) {
        host.workspaces.set(workspaceKey, {
          id: workspaceKey,
          name: tab.workspaceName,
          description: tab.workspaceDescription,
          tabs: [],
        })
      }
      host.workspaces.get(workspaceKey).tabs.push(tab)
    })

    return Array.from(hosts.values()).map((host) => ({
      ...host,
      workspaces: Array.from(host.workspaces.values()).map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.sort((left, right) => left.windowIndex - right.windowIndex),
      })),
    }))
  }, [tabs])

  return (
    <section className="terminal-organizer">
      <header className="terminal-organizer-header">
        <div>
          <h2>Terminal Tabs</h2>
          <p>Name tmux windows with local app labels. The real tmux names stay unchanged.</p>
        </div>
        <button type="button" className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      {errors.length > 0 && (
        <div className="terminal-organizer-errors">
          {errors.map((error, index) => (
            <span key={`${error.hostId || 'error'}-${index}`}>
              {error.hostName ? `${error.hostName}: ` : ''}{error.error}
            </span>
          ))}
        </div>
      )}

      {loading && tabs.length === 0 ? (
        <div className="terminal-organizer-empty">Loading tmux windows...</div>
      ) : groups.length === 0 ? (
        <div className="terminal-organizer-empty">No active tmux windows found.</div>
      ) : (
        <div className="terminal-organizer-groups">
          {groups.map((host) => (
            <section key={host.id} className="terminal-organizer-host">
              <h3>{host.name}</h3>
              {host.workspaces.map((workspace) => (
                <section key={workspace.id} className="terminal-organizer-workspace">
                  <div className="terminal-organizer-workspace-title">
                    <strong>{workspace.name}</strong>
                    {workspace.description && <small>{workspace.description}</small>}
                  </div>
                  <div className="terminal-organizer-rows">
                    {workspace.tabs.map((tab) => (
                      <TerminalLabelRow
                        key={tab.id}
                        tab={tab}
                        saving={savingId === tab.id}
                        onSaveLabel={onSaveLabel}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

export default TerminalOrganizer
