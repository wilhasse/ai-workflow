import { useCallback, useEffect, useRef, useState } from 'react'

const LIMIT_OPTIONS = [10, 20, 50]
const MAX_TEXT_BYTES = 2048

const UNAVAILABLE_MESSAGES = {
  not_configured: 'Search is not configured for this VM.',
  unreachable: 'The VM could not be reached.',
  timeout: 'The VM did not respond in time.',
  search_unavailable: 'The search command is unavailable on this VM.',
  invalid_response: 'The VM returned an unsupported search response.',
}

const copyText = async (value) => {
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

const responsePayload = async (response) => {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error || `T3 Thread Search returned ${response.status}`)
  }
  return payload
}

function CopyValue({ label, value, copyKey, copiedKey, onCopy }) {
  if (!value) return null
  return (
    <div className="t3-search-copy-row">
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" onClick={() => onCopy(copyKey, value)}>
        {copiedKey === copyKey ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function MatchCard({ hostId, match, index, copiedKey, onCopy }) {
  const prefix = `${hostId}:${index}`
  return (
    <article className="t3-search-match">
      <div className="t3-search-match-heading">
        <div>
          <h3>{match.title || 'Untitled thread'}</h3>
          <p>{match.workspace || 'Unknown workspace'}</p>
        </div>
        <span className={`t3-search-state ${match.state}`}>{match.state}</span>
      </div>

      <p className="t3-search-snippet">{match.snippet}</p>

      <div className="t3-search-meta">
        <span>{match.provider || 'Unknown provider'}</span>
        <span>{match.hitCount} {match.hitCount === 1 ? 'hit' : 'hits'}</span>
        <span>{match.matchedAt || 'Unknown match time'}</span>
      </div>

      <div className="t3-search-copy-list">
        <CopyValue
          label="T3 ID"
          value={match.t3ThreadId}
          copyKey={`${prefix}:t3`}
          copiedKey={copiedKey}
          onCopy={onCopy}
        />
        <CopyValue
          label="Codex ID"
          value={match.codexThreadId}
          copyKey={`${prefix}:codex`}
          copiedKey={copiedKey}
          onCopy={onCopy}
        />
        <CopyValue
          label="Route"
          value={match.route}
          copyKey={`${prefix}:route`}
          copiedKey={copiedKey}
          onCopy={onCopy}
        />
      </div>
    </article>
  )
}

export default function T3ThreadSearchView({ apiBase }) {
  const [hosts, setHosts] = useState([])
  const [hostsLoading, setHostsLoading] = useState(true)
  const [hostsError, setHostsError] = useState('')
  const [hostId, setHostId] = useState('')
  const [text, setText] = useState('')
  const [limit, setLimit] = useState(20)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [result, setResult] = useState(null)
  const [copiedKey, setCopiedKey] = useState('')
  const searchControllerRef = useRef(null)
  const searchSequenceRef = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setHostsLoading(true)
    setHostsError('')

    fetch(`${apiBase}/t3-thread-search/hosts`, { signal: controller.signal })
      .then(responsePayload)
      .then((payload) => setHosts(Array.isArray(payload?.hosts) ? payload.hosts : []))
      .catch((error) => {
        if (error.name !== 'AbortError') setHostsError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setHostsLoading(false)
      })

    return () => controller.abort()
  }, [apiBase])

  useEffect(() => () => searchControllerRef.current?.abort(), [])

  const handleCopy = useCallback(async (key, value) => {
    try {
      await copyText(value)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => current === key ? '' : current), 1500)
    } catch {
      setCopiedKey('')
    }
  }, [])

  const handleSubmit = async (event) => {
    event.preventDefault()
    const query = text.trim()
    if (!query) return

    searchControllerRef.current?.abort()
    const controller = new AbortController()
    const sequence = searchSequenceRef.current + 1
    searchSequenceRef.current = sequence
    searchControllerRef.current = controller
    setSearching(true)
    setSearchError('')
    setResult(null)

    try {
      const response = await fetch(`${apiBase}/t3-thread-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: hostId || null, text: query, limit }),
        signal: controller.signal,
      })
      const payload = await responsePayload(response)
      if (searchSequenceRef.current === sequence) setResult(payload)
    } catch (error) {
      if (error.name !== 'AbortError' && searchSequenceRef.current === sequence) {
        setSearchError(error.message)
      }
    } finally {
      if (searchSequenceRef.current === sequence) setSearching(false)
    }
  }

  const totalMatches = result?.results?.reduce(
    (total, hostResult) => total + (hostResult.matches?.length || 0),
    0,
  ) || 0
  const textTooLong = new TextEncoder().encode(text.trim()).length > MAX_TEXT_BYTES

  return (
    <section className="t3-search-view">
      <header className="t3-search-header">
        <div>
          <h2>T3 Thread Search</h2>
          <p>Find a T3 thread by text from one VM or every configured VM.</p>
        </div>
      </header>

      <form className="t3-search-form" onSubmit={handleSubmit}>
        <label>
          VM
          <select
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
            disabled={hostsLoading}
          >
            <option value="">All VMs</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>{host.name}</option>
            ))}
          </select>
        </label>

        <label className="t3-search-text-label">
          Prompt text
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="e.g. Movidesk ticket 160471"
            maxLength={MAX_TEXT_BYTES}
          />
        </label>

        <label>
          Limit per VM
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {LIMIT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>

        <button type="submit" disabled={!text.trim() || textTooLong}>
          {searching ? 'Restart search' : 'Search'}
        </button>
      </form>

      {hostsError && <p className="t3-search-error">VM list: {hostsError}</p>}
      {textTooLong && <p className="t3-search-error">Prompt text must be at most {MAX_TEXT_BYTES} UTF-8 bytes.</p>}
      {searchError && <p className="t3-search-error">{searchError}</p>}

      <div className="t3-search-results">
        {result && (
          <p className="t3-search-summary">
            {totalMatches} {totalMatches === 1 ? 'thread' : 'threads'} found across {result.results.length} {result.results.length === 1 ? 'VM' : 'VMs'}.
          </p>
        )}

        {searching && (
          <div className="t3-search-empty">Searching the selected VMs…</div>
        )}

        {!result && !searching && !searchError && (
          <div className="t3-search-empty">Enter text from a user prompt to locate its T3 thread.</div>
        )}

        {result?.results?.map((hostResult) => (
          <section className={`t3-search-host ${hostResult.status}`} key={hostResult.hostId}>
            <div className="t3-search-host-heading">
              <div>
                <h2>{hostResult.hostName}</h2>
                <span>{hostResult.hostId}</span>
              </div>
              <span className="t3-search-status">{hostResult.status.replace('_', ' ')}</span>
            </div>

            {hostResult.status === 'no_match' && (
              <p className="t3-search-host-message">No matching threads on this VM.</p>
            )}
            {hostResult.status === 'unavailable' && (
              <p className="t3-search-host-message">
                {UNAVAILABLE_MESSAGES[hostResult.reason] || 'Thread search is unavailable on this VM.'}
              </p>
            )}
            {hostResult.status === 'ok' && hostResult.matches.map((item, index) => (
              <MatchCard
                key={`${item.t3ThreadId}:${index}`}
                hostId={hostResult.hostId}
                match={item}
                index={index}
                copiedKey={copiedKey}
                onCopy={handleCopy}
              />
            ))}
          </section>
        ))}
      </div>
    </section>
  )
}
