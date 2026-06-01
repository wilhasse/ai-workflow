function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function highlightText(text, query) {
  if (!text || !query) return text
  const words = query.split(/\s+/).filter(Boolean)
  if (!words.length) return text

  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const parts = text.split(pattern)

  return parts.map((part, i) =>
    pattern.test(part) ? <mark key={i}>{part}</mark> : part
  )
}

function snippetAroundMatch(text, query, size = 360) {
  if (!text) return ''
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const firstHit = words
    .map((word) => lower.indexOf(word))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0]

  if (firstHit == null || text.length <= size) return text.slice(0, size)

  const start = Math.max(0, firstHit - Math.floor(size / 3))
  const end = Math.min(text.length, start + size)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function shortId(id) {
  return id && id.length > 12 ? id.slice(0, 12) + '...' : id
}

export default function SearchResults({ results, query, onSelectSession }) {
  const dedupedResults = []
  const seen = new Set()

  for (const result of results) {
    const key = [result.message_id, result.session_id, result.vm_id, result.ts].join('::')
    if (seen.has(key)) continue
    seen.add(key)
    dedupedResults.push(result)
  }

  if (!dedupedResults.length) {
    return <div className="empty-state">No results found</div>
  }

  return (
    <div className="session-list">
      <div className="results-summary">
        {dedupedResults.length} result{dedupedResults.length === 1 ? '' : 's'}
      </div>
      {dedupedResults.map((r, i) => (
        <div
          key={`${r.message_id}-${i}`}
          className="search-result"
          onClick={() => onSelectSession(r.session_id)}
        >
          <div className="search-result-meta">
            <span className={`badge badge-${r.source}`}>{r.source}</span>
            <span className="badge badge-vm">{r.vm_id}</span>
            {Number.isFinite(Number(r.relevance)) && <span className="badge badge-rank">rank {Number(r.relevance) + 1}</span>}
            <span className="session-id">{shortId(r.session_id)}</span>
            <span className="session-date">{formatDate(r.ts)}</span>
          </div>
          {r.project && (
            <div style={{ marginBottom: 4 }}>
              <span className="badge badge-project">
                {r.project?.replace(/^-home-cslog-?/, '').replace(/-/g, '/')}
              </span>
            </div>
          )}
          <div className="search-result-text">
            {highlightText(snippetAroundMatch(r.content_text, query), query)}
          </div>
        </div>
      ))}
    </div>
  )
}
