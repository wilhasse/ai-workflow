import { useState, useEffect, useRef, useCallback } from 'react'
import { listSessions, searchMessages, getSession, getSyncStatus } from './api.js'
import SessionCard from './components/SessionCard.jsx'
import SessionDetail from './components/SessionDetail.jsx'
import SearchResults from './components/SearchResults.jsx'

const LIMIT = 50

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

function getDefaultDates() {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  return { from: dateStr(yesterday), to: dateStr(today) }
}

export default function App() {
  const [sessions, setSessions] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState({ vm_id: '', source: '', project: '', ...getDefaultDates() })
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [syncInfo, setSyncInfo] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('ah-theme') || 'dark')
  const [font, setFont] = useState(() => localStorage.getItem('ah-font') || 'Outfit')
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('ah-fontsize')) || 14)

  // Use ref to always have latest filters/query in doSearch
  const filtersRef = useRef(filters)
  const queryRef = useRef(query)
  filtersRef.current = filters
  queryRef.current = query

  // Apply theme + font
  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'light' : ''
    localStorage.setItem('ah-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-ui', `'${font}', sans-serif`)
    document.documentElement.style.fontSize = `${fontSize}px`
    localStorage.setItem('ah-font', font)
    localStorage.setItem('ah-fontsize', String(fontSize))
  }, [font, fontSize])

  const doSearch = useCallback(async (append = false, off = 0) => {
    setLoading(true)
    if (!append) {
      setOffset(0)
      setSelectedSession(null)
    }
    const currentFilters = filtersRef.current
    const currentQuery = queryRef.current
    try {
      if (currentQuery.trim()) {
        const data = await searchMessages(currentQuery, { ...currentFilters, limit: LIMIT })
        setSearchResults(data)
        setSessions([])
      } else {
        setSearchResults(null)
        const data = await listSessions({ ...currentFilters, limit: LIMIT, offset: off })
        if (append) {
          setSessions(prev => [...prev, ...data])
        } else {
          setSessions(data)
        }
        setHasMore(data.length === LIMIT)
        setOffset(off + data.length)
      }
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load on mount
  useEffect(() => {
    doSearch()
    getSyncStatus().then(setSyncInfo).catch(() => {})
  }, [])

  // Auto-refresh when any filter changes (VM, source, project, dates)
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    doSearch()
  }, [filters.vm_id, filters.source, filters.project, filters.from, filters.to])

  const handleSelectSession = async (sessionId) => {
    try {
      const s = await getSession(sessionId)
      setSelectedSession(s)
    } catch {
      setSelectedSession({ session_id: sessionId, source: '', vm_id: '', project: '', started_at: '' })
    }
  }

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const totalSessions = syncInfo?.reduce((sum, s) => sum + (s.file_count || 0), 0) || 0

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-title-row">
          <div className="app-title">
            Agent History
            <span>{totalSessions > 0 && `${totalSessions} files synced`}</span>
          </div>
          <div className="settings-row">
            <select
              className="filter-select"
              value={font}
              onChange={e => setFont(e.target.value)}
            >
              <option value="Outfit">Outfit</option>
              <option value="Inter">Inter</option>
              <option value="Roboto">Roboto</option>
              <option value="JetBrains Mono">JetBrains Mono</option>
              <option value="system-ui">System</option>
            </select>
            <select
              className="filter-select"
              value={fontSize}
              onChange={e => setFontSize(Number(e.target.value))}
            >
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
            </select>
            <button
              className="theme-toggle"
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☀ Light' : '● Dark'}
            </button>
          </div>
        </div>

        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Search conversations... (full-text)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
          />
          <button className="btn-buscar" onClick={() => doSearch()} disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
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
              <button className="load-more" onClick={() => doSearch(true, offset)}>
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
