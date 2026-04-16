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
      {dedupedResults.map((r, i) => (
        <div
          key={`${r.message_id}-${i}`}
          className="search-result"
          onClick={() => onSelectSession(r.session_id)}
        >
          <div className="search-result-meta">
            <span className={`badge badge-${r.source}`}>{r.source}</span>
            <span className="badge badge-vm">{r.vm_id}</span>
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
            {highlightText(r.content_text?.slice(0, 300), query)}
          </div>
        </div>
      ))}
    </div>
  )
}
