function detectApiBase() {
  if (window.AGENT_HISTORY_API) {
    return window.AGENT_HISTORY_API
  }

  if (window.location.pathname.startsWith('/agent-history')) {
    return `${window.location.origin}/api/agent-history`
  }

  if (window.location.port === '5003') {
    return `${window.location.protocol}//${window.location.hostname}:5002`
  }

  return 'http://10.1.0.7:5002'
}

const API = detectApiBase()

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
