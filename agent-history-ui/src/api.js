const API = window.AGENT_HISTORY_API || 'http://10.1.0.7:5002'

function qs(params) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') p.set(k, v)
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

async function get(path, params = {}) {
  const res = await fetch(`${API}${path}${qs(params)}`)
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'API error')
  return data.data
}

export function searchMessages(q, filters = {}) {
  return get('/search', { q, ...filters })
}

export function listSessions(filters = {}) {
  return get('/sessions', filters)
}

export function getSession(id) {
  return get(`/sessions/${id}`)
}

export function getSessionMessages(id, opts = {}) {
  return get(`/sessions/${id}/messages`, opts)
}

export function listHistory(filters = {}) {
  return get('/history', filters)
}

export function getSyncStatus() {
  return get('/sync/status')
}

export function getStats() {
  return get('/stats')
}
