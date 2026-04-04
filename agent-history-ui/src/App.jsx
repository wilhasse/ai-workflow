import { useState, useEffect, useRef, useCallback } from 'react'
import { listSessions, searchMessages, getSession, getSyncStatus } from './api.js'
import SessionCard from './components/SessionCard.jsx'
import SessionDetail from './components/SessionDetail.jsx'
import SearchResults from './components/SearchResults.jsx'

const LIMIT = 50

export default function App() {
  const [sessions, setSessions] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState({ vm_id: '', source: '', project: '', from: '', to: '' })
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [syncInfo, setSyncInfo] = useState(null)
  const debounceRef = useRef(null)

  // Load sessions on mount and filter change
  const loadSessions = useCallback(async (off = 0, append = false) => {
    setLoading(true)
    try {
      const params = { ...filters, limit: LIMIT, offset: off }
      const data = await listSessions(params)
      if (append) {
        setSessions(prev => [...prev, ...data])
      } else {
        setSessions(data)
      }
      setHasMore(data.length === LIMIT)
      setOffset(off + data.length)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    if (!query) {
      setSearchResults(null)
      loadSessions(0)
    }
  }, [filters, loadSessions, query])

  // Load sync status
  useEffect(() => {
    getSyncStatus().then(setSyncInfo).catch(() => {})
  }, [])

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null)
      return
    }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await searchMessages(query, { ...filters, limit: LIMIT })
        setSearchResults(data)
      } catch (err) {
        console.error('Search failed:', err)
        setSearchResults([])
      } finally {
        setLoading(false)
      }
    }, 400)
    return () => clearTimeout(debounceRef.current)
  }, [query, filters])

  const handleSelectSession = async (sessionId) => {
    try {
      const s = await getSession(sessionId)
      setSelectedSession(s)
    } catch {
      // Session might not be in agent_sessions (e.g. search result only)
      setSelectedSession({ session_id: sessionId, source: '', vm_id: '', project: '', started_at: '' })
    }
  }

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    setOffset(0)
  }

  const totalSessions = syncInfo?.reduce((sum, s) => sum + (s.file_count || 0), 0) || 0

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-title">
          Agent History
          <span>{totalSessions > 0 && `${totalSessions} files synced`}</span>
        </div>

        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Search conversations... (full-text)"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        <div className="filters-row">
          <label className="filter-label">VM:</label>
          <select
            className="filter-select"
            value={filters.vm_id}
            onChange={e => handleFilterChange('vm_id', e.target.value)}
          >
            <option value="">All VMs</option>
            <option value="dev-vm">dev-vm</option>
            <option value="godev4">godev4</option>
            <option value="godev8">godev8</option>
          </select>

          <label className="filter-label">Source:</label>
          <select
            className="filter-select"
            value={filters.source}
            onChange={e => handleFilterChange('source', e.target.value)}
          >
            <option value="">All</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>

          <label className="filter-label">Project:</label>
          <input
            className="filter-input"
            type="text"
            placeholder="e.g. ai-workflow"
            value={filters.project}
            onChange={e => handleFilterChange('project', e.target.value)}
          />

          <label className="filter-label">From:</label>
          <input
            className="filter-input"
            type="date"
            value={filters.from}
            onChange={e => handleFilterChange('from', e.target.value)}
          />

          <label className="filter-label">To:</label>
          <input
            className="filter-input"
            type="date"
            value={filters.to}
            onChange={e => handleFilterChange('to', e.target.value)}
          />
        </div>
      </div>

      <div className="app-content">
        {/* Search results mode */}
        {searchResults !== null && !selectedSession && (
          <SearchResults
            results={searchResults}
            query={query}
            onSelectSession={handleSelectSession}
          />
        )}

        {/* Session list mode */}
        {searchResults === null && !selectedSession && (
          <div className="session-list">
            {loading && sessions.length === 0 && <div className="loading">Loading sessions...</div>}
            {!loading && sessions.length === 0 && <div className="empty-state">No sessions found</div>}
            {sessions.map(s => (
              <SessionCard
                key={`${s.session_id}-${s.vm_id}`}
                session={s}
                active={false}
                onClick={() => setSelectedSession(s)}
              />
            ))}
            {hasMore && sessions.length > 0 && (
              <button className="load-more" onClick={() => loadSessions(offset, true)}>
                Load more sessions
              </button>
            )}
          </div>
        )}

        {/* Session list + detail (desktop split) */}
        {selectedSession && (
          <>
            <div className="session-list with-detail">
              {(searchResults || sessions).map(s => {
                const id = s.session_id
                return (
                  <SessionCard
                    key={`${id}-${s.vm_id || ''}`}
                    session={s}
                    active={id === selectedSession.session_id}
                    onClick={() => handleSelectSession(id)}
                  />
                )
              })}
            </div>
            <SessionDetail
              session={selectedSession}
              onBack={() => setSelectedSession(null)}
            />
          </>
        )}
      </div>
    </div>
  )
}
