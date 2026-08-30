import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  conversationFolder,
  conversationTimestamp,
  conversationTitle,
  formatConversationDateTime,
  groupConversationsByDate,
} from '../../utils/conversationPresentation.js'

const API_BASE = '/api/recovery-index'

function formatDate(value) {
  const timestamp = Number(value || 0)
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortId(id, size = 12) {
  if (!id) return ''
  return id.length > size ? `${id.slice(0, size)}...` : id
}

function formatTokens(value) {
  const tokens = Number(value || 0)
  if (!tokens) return ''
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

function queryString(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, value)
    }
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

async function loadRecoveryIndex(filters) {
  const response = await fetch(`${API_BASE}${queryString(filters)}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error || `Recovery Index API returned ${response.status}`)
  }
  return payload
}

function buildManualResume(record) {
  if (!record?.resumeId) return ''
  const savedCommand = String(record.resumeCommand || '').trim()
  if (savedCommand) return savedCommand
  const tool = record.tool === 'claude' ? 'claude --resume' : 'codex resume'
  return `cd ${record.cwd || '~'} && ${tool} ${record.resumeId}`
}

async function copyText(value) {
  if (!value) return
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  document.body.removeChild(input)
}

function recordMatchesWorkspace(record, workspaceKey) {
  if (!workspaceKey) return true
  return `${record.hostId}:${record.workspaceId || '(no tmux)'}` === workspaceKey
}

function compareByRecentActivity(left, right) {
  const timestampDifference = conversationTimestamp(right) - conversationTimestamp(left)
  if (timestampDifference) return timestampDifference
  if (Boolean(right.active) !== Boolean(left.active)) return right.active ? 1 : -1

  return `${left.hostName}:${left.workspaceName}:${left.terminalIndex ?? ''}:${left.resumeId}`
    .localeCompare(`${right.hostName}:${right.workspaceName}:${right.terminalIndex ?? ''}:${right.resumeId}`)
}

function RecoveryRow({ record }) {
  const [copiedAction, setCopiedAction] = useState('')
  const manualResume = buildManualResume(record)

  const copyResume = async () => {
    if (!manualResume) return
    await copyText(manualResume)
    setCopiedAction('command')
    window.setTimeout(() => setCopiedAction(''), 1400)
  }

  const copyId = async () => {
    await copyText(record.resumeId)
    setCopiedAction('id')
    window.setTimeout(() => setCopiedAction(''), 1400)
  }

  return (
    <article className={`ri-row ${record.active ? 'active' : ''}`}>
      <div className="ri-row-main">
        <div className="ri-conversation-heading">
          <span className="ri-conversation-title">{conversationTitle(record)}</span>
          <span className="ri-conversation-time">{formatConversationDateTime(record)}</span>
        </div>
        <div className="ri-row-title">
          <span className="ri-folder" title={record.cwd}>{conversationFolder(record) || 'Unknown folder'}</span>
          <span className="ri-terminal">
            {record.workspaceName}{record.terminalIndex != null ? ` #${record.terminalIndex}` : ''}
          </span>
          {record.label && <span className="ri-label">{record.label}</span>}
          {record.status && <span className={`ri-status ${record.status}`}>{record.status}</span>}
          {record.active && <span className="ri-status active">active</span>}
          {record.historyMode && <span className="ri-runtime-badge history">{record.historyMode}</span>}
          {record.model && <span className="ri-runtime-badge">{record.model}</span>}
          {record.modelProvider && <span className="ri-runtime-badge provider">{record.modelProvider}</span>}
          {record.reasoningEffort && <span className="ri-runtime-badge effort">{record.reasoningEffort}</span>}
        </div>
        <div className="ri-prompts">
          <div><strong>First:</strong> {record.firstPrompt || 'No prompt captured'}</div>
          <div><strong>Last:</strong> {record.lastPrompt || 'No prompt captured'}</div>
        </div>
        <div className="ri-meta">
          <span>{record.hostName || record.hostId}</span>
          <span>{record.tool}</span>
          <span className="ri-conversation-id" title={record.resumeId}>ID {shortId(record.resumeId, 18)}</span>
          {record.cwd && <span title={record.cwd}>{record.cwd}</span>}
          {record.tokensUsed > 0 && <span>{formatTokens(record.tokensUsed)} tokens</span>}
        </div>
        {manualResume && (
          <code className="ri-command" title={manualResume}>{manualResume}</code>
        )}
      </div>
      <div className="ri-actions">
        <button className="secondary" type="button" onClick={copyId}>
          {copiedAction === 'id' ? 'ID copied' : 'Copy ID'}
        </button>
        <button className="secondary" type="button" onClick={copyResume} disabled={!manualResume}>
          {copiedAction === 'command' ? 'Copied' : 'Copy command'}
        </button>
      </div>
    </article>
  )
}

export default function RecoveryIndexView() {
  const [query, setQuery] = useState('')
  const [workspaceKey, setWorkspaceKey] = useState('')
  const [tool, setTool] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const records = useMemo(() => data?.records || [], [data?.records])
  const workspaces = data?.workspaces || []
  const filteredRecords = useMemo(
    () => records
      .filter((record) => recordMatchesWorkspace(record, workspaceKey))
      .sort(compareByRecentActivity),
    [records, workspaceKey],
  )
  const groupedRecords = useMemo(
    () => groupConversationsByDate(filteredRecords, { sort: false }),
    [filteredRecords],
  )

  const fetchData = useCallback(async (filters) => {
    setLoading(true)
    setError('')
    try {
      const next = await loadRecoveryIndex({ ...filters, includeLowInfo: 1, limit: 2500 })
      setData(next)
    } catch (err) {
      setError(err.message || 'Unable to load recovery index')
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback((overrides = {}) => fetchData({
    q: overrides.q ?? query,
    tool: overrides.tool ?? tool,
  }), [fetchData, query, tool])

  useEffect(() => {
    fetchData({ q: '', tool: '' })
  }, [fetchData])

  const applySearch = () => refresh()

  const reset = () => {
    setQuery('')
    setWorkspaceKey('')
    setTool('')
    refresh({ q: '', tool: '' })
  }

  return (
    <section className="ri-view">
      <header className="ri-toolbar">
        <div>
          <h2>Recovery Index</h2>
          <p>
            {data
              ? `${data.total} saved conversations · ${workspaces.length} workspaces · archive ${formatDate(data.archiveUpdatedAt)}`
              : 'Saved workspace, terminal, label, resume id, cwd, and conversation summary'}
          </p>
        </div>
        <button className="secondary" type="button" onClick={() => refresh()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      <div className="ri-controls">
        <input
          className="ri-search"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && applySearch()}
          placeholder="Search workspace, label, ticket, cwd, host, or conversation summary..."
        />
        <select value={workspaceKey} onChange={(event) => setWorkspaceKey(event.target.value)}>
          <option value="">All workspaces</option>
          {workspaces.map((workspace) => (
            <option key={`${workspace.hostId}:${workspace.workspaceId || '(no tmux)'}`} value={`${workspace.hostId}:${workspace.workspaceId || '(no tmux)'}`}>
              {workspace.hostName} / {workspace.workspaceName} ({workspace.count})
            </option>
          ))}
        </select>
        <select value={tool} onChange={(event) => {
          setTool(event.target.value)
          refresh({ tool: event.target.value })
        }}>
          <option value="">All tools</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
        <button className="primary" type="button" onClick={applySearch} disabled={loading}>Search</button>
        <button className="secondary" type="button" onClick={reset} disabled={loading}>Reset</button>
      </div>

      {error && <div className="ri-error">{error}</div>}

      <div className="ri-content">
        {loading && !records.length && <div className="ri-empty">Loading recovery index...</div>}
        {!loading && !filteredRecords.length && !error && <div className="ri-empty">No saved conversations found</div>}
        {groupedRecords.map((group) => (
          <section className="conversation-date-group" key={group.key}>
            <h3 className="conversation-date-heading">
              <span>{group.label}</span>
              <span>{group.conversations.length} conversation{group.conversations.length === 1 ? '' : 's'}</span>
            </h3>
            {group.conversations.map((record) => (
              <RecoveryRow key={`${record.tool}-${record.resumeId}`} record={record} />
            ))}
          </section>
        ))}
      </div>
    </section>
  )
}
