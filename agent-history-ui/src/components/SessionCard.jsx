import CopyButton from './CopyButton.jsx'

function formatDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function shortId(id) {
  if (!id) return ''
  return id.length > 16 ? id.slice(0, 16) + '...' : id
}

function cleanProject(p) {
  if (!p) return null
  return p.replace(/^-home-cslog-?/, '').replace(/-/g, '/') || null
}

export default function SessionCard({ session, active, onClick }) {
  const project = cleanProject(session.project)

  return (
    <div className={`session-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="session-card-header">
        <span className="session-id" title={session.session_id}>
          {shortId(session.session_id)}
        </span>
        <span className="session-date">{formatDate(session.started_at)}</span>
      </div>
      <div className="session-badges">
        <span className={`badge badge-${session.source}`}>{session.source}</span>
        <span className="badge badge-vm">{session.vm_id}</span>
        {project && <span className="badge badge-project">{project}</span>}
      </div>
      {session.display_text && (
        <div className="session-preview">{session.display_text}</div>
      )}
    </div>
  )
}
