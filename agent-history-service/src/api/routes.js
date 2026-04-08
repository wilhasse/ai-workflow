import { checkConnection } from '../db/connection.js'
import { handleIngest } from './ingest.js'
import * as queries from '../db/queries.js'

function parseQuery(url) {
  const idx = url.indexOf('?')
  if (idx === -1) return {}
  const params = new URLSearchParams(url.slice(idx))
  const obj = {}
  for (const [k, v] of params) obj[k] = v
  return obj
}

export async function route(method, url, body) {
  const path = url.split('?')[0]
  const q = parseQuery(url)

  // Health
  if (method === 'GET' && path === '/health') {
    try {
      await checkConnection()
      return { status: 200, body: { ok: true, doris: 'connected' } }
    } catch (err) {
      return { status: 503, body: { ok: false, error: err.message } }
    }
  }

  // Ingest endpoints: POST /ingest/:entity
  const ingestMatch = path.match(/^\/ingest\/([a-z-]+)$/)
  if (method === 'POST' && ingestMatch) {
    return handleIngest(ingestMatch[1], body)
  }

  // Search: GET /search?q=...
  if (method === 'GET' && path === '/search') {
    if (!q.q) return { status: 400, body: { ok: false, error: 'q parameter required' } }
    const rows = await queries.searchMessages(q.q, q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  // Sessions list: GET /sessions
  if (method === 'GET' && path === '/sessions') {
    const rows = await queries.listSessions(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  // Session detail: GET /sessions/:id
  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (method === 'GET' && sessionMatch) {
    const row = await queries.getSession(sessionMatch[1])
    if (!row) return { status: 404, body: { ok: false, error: 'Session not found' } }
    return { status: 200, body: { ok: true, data: row } }
  }

  // Session messages: GET /sessions/:id/messages
  const msgMatch = path.match(/^\/sessions\/([^/]+)\/messages$/)
  if (method === 'GET' && msgMatch) {
    const rows = await queries.getSessionMessages(msgMatch[1], q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  // History: GET /history
  if (method === 'GET' && path === '/history') {
    const rows = await queries.listHistory(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  // Tasks: GET /tasks
  if (method === 'GET' && path === '/tasks') {
    const rows = await queries.listTasks(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  // Sync status: GET /sync/status
  if (method === 'GET' && path === '/sync/status') {
    const rows = await queries.getSyncStatus()
    return { status: 200, body: { ok: true, data: rows } }
  }

  // Stats: GET /stats
  if (method === 'GET' && path === '/stats') {
    const stats = await queries.getStats()
    return { status: 200, body: { ok: true, data: stats } }
  }

  return { status: 404, body: { ok: false, error: 'Not found' } }
}
