import { useState, useEffect, useRef } from 'react'
import { listSessions, searchMessages, getSession, getSyncStatus, getStats } from './api.js'
import SessionCard from './components/SessionCard.jsx'
import SessionDetail from './components/SessionDetail.jsx'
import SearchResults from './components/SearchResults.jsx'

const LIMIT = 50

function dateStr(d) {
  // Use local date (not UTC) to match user's timezone
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const defaults = (() => {
  const today = new Date()
  const threeMonthsAgo = new Date(today)
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  return { from: dateStr(threeMonthsAgo), to: dateStr(today) }
})()

// Global fetch counter to discard stale responses
let fetchId = 0

export default function App() {
  const [sessions, setSessions] = useState([])
  const [searchResults, setSearchResults] = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [vmId, setVmId] = useState('')
  const [source, setSource] = useState('')
  const [project, setProject] = useState('')
  const [fromDate, setFromDate] = useState(defaults.from)
  const [toDate, setToDate] = useState(defaults.to)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [syncInfo, setSyncInfo] = useState(null)
  const [stats, setStats] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('ah-theme') || 'dark')
  const [font, setFont] = useState(() => localStorage.getItem('ah-font') || 'JetBrains Mono')
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('ah-fontsize')) || 14)

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

  useEffect(() => {
    getSyncStatus().then(setSyncInfo).catch(() => {})
    getStats().then(setStats).catch(() => {})
  }, [])

  // The core fetch — takes ALL filter values explicitly, uses fetchId to discard stale results
  async function doFetch(opts) {
    const myId = ++fetchId
    const filters = {}
    if (opts.vm_id) filters.vm_id = opts.vm_id
    if (opts.source) filters.source = opts.source
    if (opts.project) filters.project = opts.project
    if (opts.from) filters.from = opts.from
    if (opts.to) filters.to = opts.to

    setLoading(true)
    setSelectedSession(null)
    setOffset(0)

    try {
      if (opts.query && opts.query.trim()) {
        const data = await searchMessages(opts.query, { ...filters, limit: LIMIT })
        if (fetchId !== myId) return
        setSearchResults(data)
        setSessions([])
      } else {
        const data = await listSessions({ ...filters, limit: LIMIT, offset: 0 })
        if (fetchId !== myId) return
        setSearchResults(null)
        setSessions(data)
        setHasMore(data.length === LIMIT)
        setOffset(data.length)
      }
    } catch (err) {
      console.error('Fetch failed:', err)
    } finally {
      if (fetchId === myId) setLoading(false)
    }
  }

  // Build current filter state as explicit object
  function currentFilters(overrides = {}) {
    return {
      vm_id: overrides.vm_id ?? vmId,
      source: overrides.source ?? source,
      project: overrides.project ?? project,
      from: overrides.from ?? fromDate,
      to: overrides.to ?? toDate,
      query: overrides.query ?? query,
    }
  }

  // Initial load
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      doFetch(currentFilters())
    }
  })

  const handleSearch = () => doFetch(currentFilters())

  // Each handler passes ALL current values + the one that changed
  const handleVmChange = (v) => { setVmId(v); doFetch(currentFilters({ vm_id: v })) }
  const handleSourceChange = (v) => { setSource(v); doFetch(currentFilters({ source: v })) }
  const handleProjectChange = (v) => { setProject(v); doFetch(currentFilters({ project: v })) }
  const handleFromChange = (v) => { setFromDate(v); doFetch(currentFilters({ from: v })) }
  const handleToChange = (v) => { setToDate(v); doFetch(currentFilters({ to: v })) }

  const loadMore = async () => {
    const filters = {}
    if (vmId) filters.vm_id = vmId
    if (source) filters.source = source
    if (project) filters.project = project
    if (fromDate) filters.from = fromDate
    if (toDate) filters.to = toDate

    setLoading(true)
    try {
      const data = await listSessions({ ...filters, limit: LIMIT, offset })
      setSessions(prev => [...prev, ...data])
      setHasMore(data.length === LIMIT)
      setOffset(prev => prev + data.length)
    } catch (err) {
      console.error('Load more failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleSelectSession = async (sessionId) => {
    try {
      const s = await getSession(sessionId)
      setSelectedSession(s)
    } catch {
      setSelectedSession({ session_id: sessionId, source: '', vm_id: '', project: '', started_at: '' })
    }
  }

  const totalFiles = syncInfo?.reduce((sum, s) => sum + (s.file_count || 0), 0) || 0
  const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? (n/1e3).toFixed(1) + 'k' : String(n)

  return (
    <div className="app">
      <div className="app-header">
        <div className="app-title-row">
          <div className="app-title">
            Agent History
            <span>
              {totalFiles > 0 && `${fmt(totalFiles)} files`}
              {stats && ` · ${fmt(stats.sessions)} conversations · ${fmt(stats.messages)} messages · ${fmt(stats.words)} words`}
            </span>
          </div>
          <div className="settings-row">
            <select className="filter-select" value={font} onChange={e => setFont(e.target.value)}>
              <option value="Outfit">Outfit</option>
              <option value="Inter">Inter</option>
              <option value="Roboto">Roboto</option>
              <option value="JetBrains Mono">JetBrains Mono</option>
              <option value="system-ui">System</option>
            </select>
            <select className="filter-select" value={fontSize} onChange={e => setFontSize(Number(e.target.value))}>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
            </select>
            <button className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
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
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button className="btn-buscar" onClick={handleSearch} disabled={loading}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>

        <div className="filters-row">
          <label className="filter-label">VM:</label>
          <select className="filter-select" value={vmId} onChange={e => handleVmChange(e.target.value)}>
            <option value="">All VMs</option>
            <option value="dev-vm">dev-vm</option>
            <option value="godev4">godev4</option>
            <option value="godev8">godev8</option>
          </select>

          <label className="filter-label">Source:</label>
          <select className="filter-select" value={source} onChange={e => handleSourceChange(e.target.value)}>
            <option value="">All</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>

          <label className="filter-label">Project:</label>
          <input
            className="filter-input"
            type="text"
            placeholder="e.g. ai-workflow"
            value={project}
            onChange={e => handleProjectChange(e.target.value)}
          />

          <label className="filter-label">From:</label>
          <input className="filter-input" type="date" value={fromDate} onChange={e => handleFromChange(e.target.value)} />

          <label className="filter-label">To:</label>
          <input className="filter-input" type="date" value={toDate} onChange={e => handleToChange(e.target.value)} />
        </div>
      </div>

      <div className="app-content">
        {searchResults !== null && !selectedSession && (
          <SearchResults results={searchResults} query={query} onSelectSession={handleSelectSession} />
        )}

        {searchResults === null && !selectedSession && (
          <div className="session-list">
            {loading && sessions.length === 0 && <div className="loading">Loading sessions...</div>}
            {!loading && sessions.length === 0 && <div className="empty-state">No sessions found</div>}
            {sessions.map(s => (
              <SessionCard key={`${s.session_id}-${s.vm_id}`} session={s} active={false} onClick={() => setSelectedSession(s)} />
            ))}
            {hasMore && sessions.length > 0 && (
              <button className="load-more" onClick={loadMore}>Load more sessions</button>
            )}
          </div>
        )}

        {selectedSession && (
          <>
            <div className="session-list with-detail">
              {(searchResults || sessions).map(s => (
                <SessionCard
                  key={`${s.session_id}-${s.vm_id || ''}`}
                  session={s}
                  active={s.session_id === selectedSession.session_id}
                  onClick={() => handleSelectSession(s.session_id)}
                />
              ))}
            </div>
            <SessionDetail session={selectedSession} onBack={() => setSelectedSession(null)} />
          </>
        )}
      </div>
    </div>
  )
}
