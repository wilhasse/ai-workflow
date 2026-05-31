// Base URL mirrors the page origin; nginx proxies /api/transcribe/* to the service.
const BASE = `${window.location.origin}/api/transcribe`

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(detail)
  }
  return res.json()
}

export function submitTranscript(url) {
  return request('/jobs', { method: 'POST', body: JSON.stringify({ url }) })
}

export function listTranscripts() {
  return request('/jobs')
}

export function getTranscript(videoId) {
  return request(`/jobs/${videoId}`)
}
