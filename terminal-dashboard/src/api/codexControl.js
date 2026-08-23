const API_BASE = '/api/codex'

export const codexControlUrl = (path = '') => `${API_BASE}${path}`

export async function codexControlRequest(path, options = {}) {
  const response = await fetch(codexControlUrl(path), {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error || `Codex Control API returned ${response.status}`)
  }
  return payload
}
