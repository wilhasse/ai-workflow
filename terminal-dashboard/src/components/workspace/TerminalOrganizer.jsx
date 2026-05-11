import { useEffect, useMemo, useState } from 'react'

const AUTO_REFRESH_SECONDS = 5
const STATUS_OPTIONS = [
  { value: '', label: 'Active' },
  { value: 'check', label: 'Check' },
  { value: 'idle', label: 'Idle' },
]

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

const normalizeStatus = (value) => (value === 'check' || value === 'idle' ? value : '')

const draftFromValue = (value, tab) => {
  if (value && typeof value === 'object') {
    return {
      label: value.label ?? '',
      status: normalizeStatus(value.status),
    }
  }
  return {
    label: typeof value === 'string' ? value : (tab.label || ''),
    status: normalizeStatus(tab.status),
  }
}

const draftMatchesTab = (tab, draft) => (
  (draft.label ?? '').trim() === (tab.label || '') &&
  normalizeStatus(draft.status) === normalizeStatus(tab.status)
)

const changedDraftIds = (tabs, drafts) => {
  const changed = []
  tabs.forEach((tab) => {
    if (!Object.prototype.hasOwnProperty.call(drafts, tab.id)) {
      return
    }
    const draft = draftFromValue(drafts[tab.id], tab)
    if (!draftMatchesTab(tab, draft)) {
      changed.push(tab.id)
    }
  })
  return changed
}

function TerminalLabelRow({ tab, value, status, changed, disabled, onChange, onStatusChange, onSubmit }) {
  return (
    <form
      className={`terminal-organizer-row ${changed ? 'changed' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !disabled) {
          onSubmit()
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
        value={value}
        onChange={(event) => onChange(tab, event.target.value)}
        placeholder="Short label"
        maxLength={80}
        disabled={disabled}
        aria-label={`Label for ${tab.workspaceName} window ${tab.windowIndex}`}
      />
      <div className="terminal-status-control" role="group" aria-label={`Status for ${tab.workspaceName} window ${tab.windowIndex}`}>
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value || 'active'}
            type="button"
            className={normalizeStatus(status) === option.value ? 'active' : ''}
            disabled={disabled}
            onClick={() => onStatusChange(tab, option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </form>
  )
}

function TerminalOrganizer({
  tabs = [],
  loading,
  errors = [],
  saving,
  onRefresh,
  onSaveLabels,
}) {
  const [drafts, setDrafts] = useState({})
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(AUTO_REFRESH_SECONDS)

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

  const changedIds = useMemo(() => changedDraftIds(tabs, drafts), [drafts, tabs])
  const hasChanges = changedIds.length > 0

  useEffect(() => {
    setDrafts((previousDrafts) => {
      const tabMap = new Map(tabs.map((tab) => [tab.id, tab]))
      const nextDrafts = {}
      Object.entries(previousDrafts).forEach(([tabId, draft]) => {
        const tab = tabMap.get(tabId)
        if (!tab) {
          return
        }
        const normalizedDraft = draftFromValue(draft, tab)
        if (!draftMatchesTab(tab, normalizedDraft)) {
          nextDrafts[tabId] = normalizedDraft
        }
      })
      return nextDrafts
    })
  }, [tabs])

  useEffect(() => {
    if (hasChanges || loading || saving) {
      setSecondsUntilRefresh(AUTO_REFRESH_SECONDS)
      return undefined
    }

    const timeoutId = window.setTimeout(() => {
      if (secondsUntilRefresh <= 1) {
        setSecondsUntilRefresh(AUTO_REFRESH_SECONDS)
        onRefresh()
        return
      }
      setSecondsUntilRefresh(secondsUntilRefresh - 1)
    }, 1000)

    return () => window.clearTimeout(timeoutId)
  }, [hasChanges, loading, onRefresh, saving, secondsUntilRefresh])

  const handleDraftChange = (tab, value) => {
    setDrafts((previousDrafts) => {
      const nextDrafts = { ...previousDrafts }
      const draft = {
        ...draftFromValue(nextDrafts[tab.id], tab),
        label: value,
      }
      if (draftMatchesTab(tab, draft)) {
        delete nextDrafts[tab.id]
      } else {
        nextDrafts[tab.id] = draft
      }
      return nextDrafts
    })
  }

  const handleStatusChange = (tab, status) => {
    setDrafts((previousDrafts) => {
      const nextDrafts = { ...previousDrafts }
      const draft = {
        ...draftFromValue(nextDrafts[tab.id], tab),
        status: normalizeStatus(status),
      }
      if (draftMatchesTab(tab, draft)) {
        delete nextDrafts[tab.id]
      } else {
        nextDrafts[tab.id] = draft
      }
      return nextDrafts
    })
  }

  const handleSaveChanges = async () => {
    const updates = tabs
      .filter((tab) => changedIds.includes(tab.id))
      .map((tab) => ({
        ...tab,
        labelBeforeSave: tab.label || '',
        statusBeforeSave: normalizeStatus(tab.status),
        label: draftFromValue(drafts[tab.id], tab).label,
        status: draftFromValue(drafts[tab.id], tab).status,
      }))
    if (!updates.length) {
      return
    }

    const saved = await onSaveLabels(updates)
    if (saved) {
      setDrafts({})
    }
  }

  const handleDiscardChanges = () => {
    setDrafts({})
  }

  return (
    <section className="terminal-organizer">
      <header className="terminal-organizer-header">
        <div>
          <h2>Terminal Tabs</h2>
          <p>Name tmux windows and flag tabs that need checking or are idle for now.</p>
        </div>
        <div className="terminal-organizer-toolbar">
          <span className={`terminal-organizer-refresh-status ${hasChanges ? 'paused' : ''}`}>
            {hasChanges ? `${changedIds.length} unsaved` : `Auto ${secondsUntilRefresh}s`}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={handleSaveChanges}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving' : 'Save changes'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={handleDiscardChanges}
            disabled={!hasChanges || saving}
          >
            Revert
          </button>
          <button type="button" className="secondary" onClick={onRefresh} disabled={loading || saving}>
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
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
                        value={draftFromValue(drafts[tab.id], tab).label}
                        status={draftFromValue(drafts[tab.id], tab).status}
                        changed={changedIds.includes(tab.id)}
                        disabled={saving}
                        onChange={handleDraftChange}
                        onStatusChange={handleStatusChange}
                        onSubmit={handleSaveChanges}
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
