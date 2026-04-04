import { useState, useEffect } from 'react'
import { getSessionMessages } from '../api.js'
import CopyButton from './CopyButton.jsx'
import MessageBubble from './MessageBubble.jsx'

function formatDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function cleanProject(p) {
  if (!p) return null
  return p.replace(/^-home-cslog-?/, '').replace(/-/g, '/') || null
}

export default function SessionDetail({ session, onBack }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const limit = 200

  useEffect(() => {
    setMessages([])
    setOffset(0)
    setHasMore(true)
    setLoading(true)
    loadMessages(0)
  }, [session.session_id])

  async function loadMessages(off) {
    try {
      const data = await getSessionMessages(session.session_id, { limit, offset: off })
      if (off === 0) {
        setMessages(data)
      } else {
        setMessages(prev => [...prev, ...data])
      }
      setHasMore(data.length === limit)
      setOffset(off + data.length)
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      setLoading(false)
    }
  }

  const project = cleanProject(session.project)

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <button className="detail-back" onClick={onBack}>← Back to sessions</button>
        <div className="detail-meta">
          <div className="detail-session-id">
            <span title={session.session_id}>{session.session_id}</span>
            <CopyButton text={session.session_id} />
          </div>
        </div>
        <div className="detail-meta" style={{ marginTop: 6 }}>
          <span className={`badge badge-${session.source}`}>{session.source}</span>
          <span className="badge badge-vm">{session.vm_id}</span>
          {project && <span className="badge badge-project">{project}</span>}
          <span className="session-date">{formatDate(session.started_at)}</span>
        </div>
      </div>

      <div className="messages-list">
        {loading && <div className="loading">Loading messages...</div>}
        {!loading && messages.length === 0 && (
          <div className="empty-state">No messages in this session</div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={msg.message_id || i} message={msg} />
        ))}
        {hasMore && !loading && (
          <button className="load-more" onClick={() => loadMessages(offset)}>
            Load more messages
          </button>
        )}
      </div>
    </div>
  )
}
