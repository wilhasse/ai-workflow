import { useState } from 'react'
import { useTranscripts } from '../../hooks/useTranscripts'
import { getTranscript, submitTranscript } from '../../api/transcribe'

const STATUS_ICON = { done: '✓', processing: '⧗', queued: '⧗', failed: '✗' }

function formatDuration(seconds) {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TranscriptsView({ active }) {
  const { items, error, refresh, setItems } = useTranscripts(active)
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [selected, setSelected] = useState(null)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!url.trim()) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const job = await submitTranscript(url.trim())
      setItems((prev) => [job, ...prev.filter((p) => p.video_id !== job.video_id)])
      setUrl('')
      refresh()
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const openDetail = async (videoId) => {
    try {
      setSelected(await getTranscript(videoId))
    } catch (err) {
      setSubmitError(err.message)
    }
  }

  return (
    <div className="transcripts-view">
      <form className="transcripts-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Paste a YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || !url.trim()}>
          {submitting ? 'Submitting…' : 'Transcribe'}
        </button>
      </form>
      {submitError && <div className="transcripts-error">{submitError}</div>}
      {error && <div className="transcripts-error">{error}</div>}

      <div className="transcripts-body">
        <ul className="transcripts-list">
          {items.length === 0 && <li className="transcripts-empty">No transcripts yet.</li>}
          {items.map((item) => (
            <li
              key={item.video_id}
              className={`transcripts-row ${selected?.video_id === item.video_id ? 'selected' : ''}`}
              onClick={() => openDetail(item.video_id)}
            >
              <span className={`status status-${item.status}`}>{STATUS_ICON[item.status] || '•'}</span>
              <span className="title">{item.title || item.url}</span>
              <span className="meta">
                {item.language || ''} {formatDuration(item.duration_seconds)}
              </span>
            </li>
          ))}
        </ul>

        {selected && (
          <div className="transcripts-detail">
            <div className="detail-header">
              <h3>{selected.title || selected.video_id}</h3>
              <a href={selected.url} target="_blank" rel="noreferrer">Open video ↗</a>
              <button type="button" onClick={() => navigator.clipboard.writeText(selected.transcript_text || '')}>
                Copy
              </button>
            </div>
            {selected.status === 'failed' && <div className="transcripts-error">{selected.error}</div>}
            <pre className="detail-text">{selected.transcript_text || '(no transcript yet)'}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
