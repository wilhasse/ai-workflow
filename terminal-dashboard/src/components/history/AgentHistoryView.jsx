import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  compareConversationRecency,
  conversationFolder,
  conversationTimestamp,
  conversationTitle,
  formatConversationDateTime,
  groupConversationsByDate,
} from '../../utils/conversationPresentation.js'

const LIMIT = 50
const DETAIL_LIMIT = 200
const API_BASE = '/api/agent-history'

function dateStr(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function defaultDates() {
  const today = new Date()
  const from = new Date(today)
  from.setMonth(from.getMonth() - 3)
  return { from: dateStr(from), to: dateStr(today) }
}

function formatCount(value) {
  const n = Number(value) || 0
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function formatDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function cleanProject(project) {
  if (!project) return ''
  return project.replace(/^-home-cslog-?/, '').replace(/-/g, '/')
}

function shortId(id, size = 12) {
  if (!id) return ''
  return id.length > size ? `${id.slice(0, size)}...` : id
}

async function copyText(text) {
  if (!text) return
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  document.body.removeChild(input)
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

async function apiGet(path, params = {}) {
  const response = await fetch(`${API_BASE}${path}${queryString(params)}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Agent History API returned ${response.status}`)
  }
  return payload.data
}

async function loadCodexConversationIndex() {
  const response = await fetch('/api/recovery-index?tool=codex&includeLowInfo=1&limit=2500')
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || 'Unable to load Codex conversation metadata')
  const records = Array.isArray(payload?.records) ? payload.records : []
  const index = new Map()
  for (const record of records) {
    const id = String(record.resumeId || '')
    if (!id) continue
    const previous = index.get(id)
    if (!previous || compareConversationRecency(record, previous) < 0) index.set(id, record)
  }
  return index
}

function enrichConversation(session, conversationIndex) {
  const metadata = conversationIndex.get(String(session?.session_id || ''))
  if (!metadata || (session.source && session.source !== 'codex')) return session
  return {
    ...session,
    conversationTitle: metadata.conversationTitle || metadata.summary,
    conversationAt: metadata.conversationAt || metadata.updatedAt || metadata.score,
    cwd: metadata.cwd || session.project,
    folder: metadata.folder,
    historyMode: metadata.historyMode,
    resumeCommand: metadata.resumeCommand,
    project: metadata.cwd || session.project,
  }
}

function conversationMetadataMatches(record, filters) {
  if (!filters?.query || (filters.source && filters.source !== 'codex')) return false
  if (filters.vm_id) {
    const hostValues = [record.hostId, record.hostName].map((value) => String(value || '').toLowerCase())
    if (!hostValues.includes(String(filters.vm_id).toLowerCase())) return false
  }
  if (filters.project) {
    const folder = `${record.cwd || ''} ${record.folder || ''}`.toLowerCase()
    if (!folder.includes(String(filters.project).toLowerCase())) return false
  }

  const timestamp = conversationTimestamp(record)
  const fromTimestamp = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : 0
  const toTimestamp = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : 0
  if (fromTimestamp && timestamp < fromTimestamp) return false
  if (toTimestamp && timestamp > toTimestamp) return false

  const haystack = [
    record.conversationTitle,
    record.summary,
    record.cwd,
    record.folder,
    record.resumeId,
    record.firstPrompt,
    record.lastPrompt,
  ].join(' ').toLowerCase()
  const terms = String(filters.query).toLowerCase().split(/\s+/).filter(Boolean)
  return terms.length > 0 && terms.every((term) => haystack.includes(term))
}

function metadataSearchResult(record) {
  const title = conversationTitle(record)
  const folder = record.cwd || record.folder || 'Unknown folder'
  return {
    ...record,
    message_id: `conversation-metadata:${record.resumeId}`,
    session_id: record.resumeId,
    vm_id: record.hostId || record.hostName || 'local',
    source: 'codex',
    project: record.cwd,
    display_text: title,
    ts: record.conversationAt,
    content_text: `Matched SQLite conversation metadata · ${folder} · ${record.resumeId}`,
    metadataMatch: true,
  }
}

function mergeMetadataSearchResults(results, conversationIndex, filters) {
  const merged = results.map((result) => enrichConversation(result, conversationIndex))
  const seenSessions = new Set(merged.map((result) => String(result.session_id || '')))
  for (const record of conversationIndex.values()) {
    if (!conversationMetadataMatches(record, filters) || seenSessions.has(String(record.resumeId))) continue
    merged.push(metadataSearchResult(record))
    seenSessions.add(String(record.resumeId))
  }
  return merged
}

function highlightText(text, query) {
  if (!text || !query) return text
  const words = query.split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(pattern).map((part, index) => (
    pattern.test(part) ? <mark key={`${part}-${index}`}>{part}</mark> : part
  ))
}

function snippetAroundMatch(text, query, size = 360) {
  if (!text) return ''
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const firstHit = words
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]

  if (firstHit == null || text.length <= size) return text.slice(0, size)

  const start = Math.max(0, firstHit - Math.floor(size / 3))
  const end = Math.min(text.length, start + size)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function SourceBadge({ source }) {
  return <span className={`ah-badge ah-badge-${source || 'unknown'}`}>{source || 'unknown'}</span>
}

function ConversationId({ id, copied, onCopy, full = false }) {
  if (!id) return null
  return (
    <span className="ah-conversation-id">
      <span className="ah-session-id" title={id}>{full ? id : shortId(id, 16)}</span>
      <span
        className={`ah-copy-id ${copied ? 'copied' : ''}`}
        role="button"
        tabIndex={0}
        title="Copy conversation id"
        onClick={(event) => {
          event.stopPropagation()
          onCopy(id)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onCopy(id)
        }}
      >
        {copied ? 'Copied' : 'Copy ID'}
      </span>
    </span>
  )
}

function SessionCard({ session, active, copiedSessionId, onCopySessionId, onClick }) {
  const title = conversationTitle(session)
  const preview = String(session.display_text || '').replace(/\s+/g, ' ').trim()
  return (
    <button className={`ah-session-card ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      <span className="ah-session-card-top">
        <span className="ah-conversation-title">{title}</span>
        <span className="ah-muted">{formatConversationDateTime(session)}</span>
      </span>
      <span className="ah-badge-row">
        <SourceBadge source={session.source} />
        <span className="ah-badge ah-badge-vm">{session.vm_id}</span>
        {(session.cwd || session.project) && (
          <span className="ah-badge ah-badge-project" title={session.cwd || session.project}>
            {conversationFolder(session) || cleanProject(session.project)}
          </span>
        )}
        {session.historyMode && <span className="ah-badge ah-badge-history">{session.historyMode}</span>}
        <ConversationId
          id={session.session_id}
          copied={copiedSessionId === session.session_id}
          onCopy={onCopySessionId}
        />
      </span>
      {preview && preview !== title && <span className="ah-preview">{preview}</span>}
    </button>
  )
}

function SearchResults({ results, query, copiedSessionId, onCopySessionId, onSelectSession }) {
  if (!results.length) return <div className="ah-empty">No results found</div>

  return (
    <div className="ah-list">
      <div className="ah-results-summary">{results.length} result{results.length === 1 ? '' : 's'}</div>
      {results.map((result, index) => (
        <button
          className="ah-search-result"
          key={`${result.message_id}-${result.session_id}-${index}`}
          type="button"
          onClick={() => onSelectSession(result)}
        >
          <span className="ah-conversation-title">{conversationTitle(result)}</span>
          <span className="ah-search-meta">
            <SourceBadge source={result.source} />
            <span className="ah-badge ah-badge-vm">{result.vm_id}</span>
            {result.metadataMatch && <span className="ah-badge ah-badge-metadata">SQLite metadata</span>}
            {Number.isFinite(Number(result.relevance)) && (
              <span className="ah-badge ah-badge-rank">rank {Number(result.relevance) + 1}</span>
            )}
            <ConversationId
              id={result.session_id}
              copied={copiedSessionId === result.session_id}
              onCopy={onCopySessionId}
            />
            <span className="ah-muted">{formatConversationDateTime(result)}</span>
          </span>
          {result.project && (
            <span className="ah-badge ah-badge-project" title={result.project}>
              {conversationFolder(result) || cleanProject(result.project)}
            </span>
          )}
          <span className="ah-result-text">{highlightText(snippetAroundMatch(result.content_text, query), query)}</span>
        </button>
      ))}
    </div>
  )
}

function MessageBubble({ message }) {
  const role = message.msg_role || message.msg_type || 'unknown'
  if (!message.content_text) return null
  return (
    <div className={`ah-message ${role === 'user' ? 'user' : 'assistant'}`}>
      <div className="ah-message-role">{role}</div>
      <div className="ah-message-text">{message.content_text}</div>
      <div className="ah-muted">{formatDate(message.ts)}</div>
    </div>
  )
}

function SessionDetail({ session, copiedSessionId, onCopySessionId, onBack }) {
  const [messages, setMessages] = useState([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')

  const loadMessages = useCallback(async (nextOffset) => {
    setLoading(true)
    setError('')
    try {
      const data = await apiGet(`/sessions/${session.session_id}/messages`, {
        limit: DETAIL_LIMIT,
        offset: nextOffset,
      })
      setMessages((current) => nextOffset === 0 ? data : [...current, ...data])
      setOffset(nextOffset + data.length)
      setHasMore(data.length === DETAIL_LIMIT)
    } catch (err) {
      setError(err.message || 'Unable to load messages')
    } finally {
      setLoading(false)
    }
  }, [session.session_id])

  useEffect(() => {
    setMessages([])
    setOffset(0)
    setHasMore(true)
    loadMessages(0)
  }, [loadMessages, session.session_id])

  return (
    <section className="ah-detail">
      <header className="ah-detail-header">
        <button className="secondary" type="button" onClick={onBack}>Back</button>
        <div className="ah-detail-title">
          <span className="ah-conversation-title">{conversationTitle(session)}</span>
          <ConversationId
            id={session.session_id}
            copied={copiedSessionId === session.session_id}
            onCopy={onCopySessionId}
            full
          />
          <span className="ah-badge-row">
            <SourceBadge source={session.source} />
            <span className="ah-badge ah-badge-vm">{session.vm_id}</span>
            {session.project && (
              <span className="ah-badge ah-badge-project" title={session.project}>
                {conversationFolder(session) || cleanProject(session.project)}
              </span>
            )}
            {session.historyMode && <span className="ah-badge ah-badge-history">{session.historyMode}</span>}
            <span className="ah-muted">{formatConversationDateTime(session)}</span>
          </span>
        </div>
      </header>
      {error && <div className="ah-error">{error}</div>}
      <div className="ah-messages">
        {loading && messages.length === 0 && <div className="ah-loading">Loading messages...</div>}
        {!loading && messages.length === 0 && !error && <div className="ah-empty">No messages in this session</div>}
        {messages.map((message, index) => (
          <MessageBubble key={message.message_id || `${message.session_id}-${index}`} message={message} />
        ))}
        {hasMore && !loading && messages.length > 0 && (
          <button className="ah-load-more" type="button" onClick={() => loadMessages(offset)}>
            Load more messages
          </button>
        )}
      </div>
    </section>
  )
}

export default function AgentHistoryView() {
  const dates = useMemo(defaultDates, [])
  const requestId = useRef(0)
  const [query, setQuery] = useState('')
  const [vmId, setVmId] = useState('')
  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [fromDate, setFromDate] = useState(dates.from)
  const [toDate, setToDate] = useState(dates.to)
  const [sessions, setSessions] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [searchContext, setSearchContext] = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [syncInfo, setSyncInfo] = useState([])
  const [stats, setStats] = useState(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedSessionId, setCopiedSessionId] = useState('')
  const [conversationIndex, setConversationIndex] = useState(() => new Map())
  const copiedTimerRef = useRef(null)

  const vmOptions = useMemo(
    () => Array.from(new Set(syncInfo.map((item) => item.vm_id).filter(Boolean))).sort(),
    [syncInfo],
  )
  const totalFiles = syncInfo.reduce((sum, item) => sum + (Number(item.file_count) || 0), 0)
  const enrichedSessions = useMemo(
    () => sessions.map((session) => enrichConversation(session, conversationIndex)).sort(compareConversationRecency),
    [conversationIndex, sessions],
  )
  const enrichedSearchResults = useMemo(
    () => searchResults === null
      ? null
      : mergeMetadataSearchResults(searchResults, conversationIndex, searchContext),
    [conversationIndex, searchContext, searchResults],
  )
  const groupedSessions = useMemo(
    () => groupConversationsByDate(enrichedSessions, { sort: false }),
    [enrichedSessions],
  )
  const selectedConversation = useMemo(
    () => selectedSession ? enrichConversation(selectedSession, conversationIndex) : null,
    [conversationIndex, selectedSession],
  )
  const sideConversations = enrichedSearchResults || enrichedSessions

  const currentFilters = (overrides = {}) => ({
    vm_id: overrides.vm_id ?? vmId,
    source: overrides.source ?? source,
    project: overrides.project ?? project,
    from: overrides.from ?? fromDate,
    to: overrides.to ?? toDate,
    query: overrides.query ?? query,
  })

  const loadData = useCallback(async (filters) => {
    const id = ++requestId.current
    const baseFilters = {
      vm_id: filters.vm_id,
      source: filters.source,
      project: filters.project,
      from: filters.from,
      to: filters.to,
      limit: LIMIT,
      offset: 0,
    }

    setLoading(true)
    setError('')
    setSelectedSession(null)
    setOffset(0)

    try {
      if (filters.query?.trim()) {
        const data = await apiGet('/search', { ...baseFilters, q: filters.query.trim() })
        if (requestId.current !== id) return
        setSearchContext({ ...baseFilters, query: filters.query.trim() })
        setSearchResults(data)
        setSessions([])
        setHasMore(false)
      } else {
        const data = await apiGet('/sessions', baseFilters)
        if (requestId.current !== id) return
        setSearchContext(null)
        setSearchResults(null)
        setSessions(data)
        setOffset(data.length)
        setHasMore(data.length === LIMIT)
      }
    } catch (err) {
      if (requestId.current !== id) return
      setError(err.message || 'Unable to load conversations')
    } finally {
      if (requestId.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    apiGet('/sync/status').then(setSyncInfo).catch(() => {})
    apiGet('/stats').then(setStats).catch(() => {})
    loadCodexConversationIndex().then(setConversationIndex).catch(() => {})
    loadData({ query: '', vm_id: '', source: '', project: '', from: dates.from, to: dates.to })
  }, [dates.from, dates.to, loadData])

  const updateFilter = (key, value) => {
    const next = currentFilters({ [key]: value })
    if (key === 'vm_id') setVmId(value)
    if (key === 'source') setSource(value)
    if (key === 'project') setProject(value)
    if (key === 'from') setFromDate(value)
    if (key === 'to') setToDate(value)
    loadData(next)
  }

  const resetFilters = () => {
    setQuery('')
    setVmId('')
    setSource('')
    setProject('')
    setFromDate(dates.from)
    setToDate(dates.to)
    loadData({ query: '', vm_id: '', source: '', project: '', from: dates.from, to: dates.to })
  }

  const loadMore = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiGet('/sessions', {
        vm_id: vmId,
        source,
        project,
        from: fromDate,
        to: toDate,
        limit: LIMIT,
        offset,
      })
      setSessions((current) => [...current, ...data])
      setOffset((current) => current + data.length)
      setHasMore(data.length === LIMIT)
    } catch (err) {
      setError(err.message || 'Unable to load more sessions')
    } finally {
      setLoading(false)
    }
  }

  const selectSession = async (session) => {
    setSelectedSession({
      session_id: session.session_id,
      vm_id: session.vm_id,
      source: session.source,
      project: session.project,
      started_at: session.started_at || session.ts,
    })
  }

  const copySessionId = async (sessionId) => {
    try {
      await copyText(sessionId)
      setCopiedSessionId(sessionId)
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopiedSessionId(''), 1600)
    } catch (err) {
      setError(err.message || 'Unable to copy conversation id')
    }
  }

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), [])

  return (
    <section className="ah-view">
      <header className="ah-toolbar">
        <div>
          <h2>Agent History</h2>
          <p>
            {stats
              ? `${formatCount(stats.sessions)} conversations · ${formatCount(stats.messages)} messages · ${formatCount(stats.words)} words`
              : 'Conversation history from Codex and Claude collectors'}
          </p>
        </div>
        <a className="secondary ah-fallback-link" href="http://10.1.0.7:5003" target="_blank" rel="noreferrer">
          Fallback standalone
        </a>
      </header>

      <div className="ah-controls">
        <div className="ah-search-row">
          <input
            className="ah-search-input"
            type="text"
            placeholder="Search by phrase, issue, host, file, error, command..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && loadData(currentFilters())}
          />
          <button className="primary" type="button" onClick={() => loadData(currentFilters())} disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
          <button className="secondary" type="button" onClick={resetFilters} disabled={loading}>Reset</button>
        </div>

        <div className="ah-filter-row">
          <label>
            VM
            <select value={vmId} onChange={(event) => updateFilter('vm_id', event.target.value)}>
              <option value="">All VMs</option>
              {vmOptions.map((vm) => <option key={vm} value={vm}>{vm}</option>)}
            </select>
          </label>
          <label>
            Source
            <select value={source} onChange={(event) => updateFilter('source', event.target.value)}>
              <option value="">All</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Project
            <input value={project} onChange={(event) => updateFilter('project', event.target.value)} placeholder="e.g. ai-workflow" />
          </label>
          <label>
            From
            <input type="date" value={fromDate} onChange={(event) => updateFilter('from', event.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={toDate} onChange={(event) => updateFilter('to', event.target.value)} />
          </label>
        </div>

        <div className="ah-sync-line">
          {syncInfo.length > 0 && `${formatCount(totalFiles)} indexed files across ${vmOptions.length} VM${vmOptions.length === 1 ? '' : 's'}`}
        </div>
        {error && <div className="ah-error">{error}</div>}
      </div>

      <div className="ah-content">
        {selectedConversation ? (
          <>
            <div className="ah-side-list">
              {sideConversations.map((session, index) => (
                <SessionCard
                  key={`${session.session_id}-${session.vm_id || ''}-${index}`}
                  session={session}
                  active={session.session_id === selectedConversation.session_id}
                  copiedSessionId={copiedSessionId}
                  onCopySessionId={copySessionId}
                  onClick={() => selectSession(session)}
                />
              ))}
            </div>
            <SessionDetail
              session={selectedConversation}
              copiedSessionId={copiedSessionId}
              onCopySessionId={copySessionId}
              onBack={() => setSelectedSession(null)}
            />
          </>
        ) : enrichedSearchResults ? (
          <SearchResults
            results={enrichedSearchResults}
            query={query}
            copiedSessionId={copiedSessionId}
            onCopySessionId={copySessionId}
            onSelectSession={selectSession}
          />
        ) : (
          <div className="ah-list">
            {loading && sessions.length === 0 && <div className="ah-loading">Loading sessions...</div>}
            {!loading && sessions.length === 0 && !error && <div className="ah-empty">No sessions found</div>}
            {groupedSessions.map((group) => (
              <section className="conversation-date-group" key={group.key}>
                <h3 className="conversation-date-heading">
                  <span>{group.label}</span>
                  <span>{group.conversations.length} conversation{group.conversations.length === 1 ? '' : 's'}</span>
                </h3>
                {group.conversations.map((session, index) => (
                  <SessionCard
                    key={`${session.session_id}-${session.vm_id || ''}-${index}`}
                    session={session}
                    active={false}
                    copiedSessionId={copiedSessionId}
                    onCopySessionId={copySessionId}
                    onClick={() => selectSession(session)}
                  />
                ))}
              </section>
            ))}
            {hasMore && sessions.length > 0 && (
              <button className="ah-load-more" type="button" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading...' : 'Load more sessions'}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
