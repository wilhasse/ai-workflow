import crypto from 'node:crypto'
import config from '../config.js'
import { checkConnection } from '../db/connection.js'
import { handleIngest } from './ingest.js'
import { buildHandoff } from './handoff.js'
import * as queries from '../db/queries.js'

function parseQuery(url) {
  const idx = url.indexOf('?')
  if (idx === -1) return {}
  const params = new URLSearchParams(url.slice(idx))
  const obj = {}
  for (const [k, v] of params) obj[k] = v
  return obj
}

export function authorized(req) {
  if (!config.apiToken) return true
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(token)
  const b = Buffer.from(config.apiToken)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function route(method, url, body) {
  const path = url.split('?')[0]
  const q = parseQuery(url)

  if (method === 'GET' && path === '/health') {
    try {
      await checkConnection()
      return { status: 200, body: { ok: true, mysql: 'connected' } }
    } catch (err) {
      return { status: 503, body: { ok: false, error: err.message } }
    }
  }

  // Ingest endpoints: POST /ingest/:entity (same contract as the Doris service)
  const ingestMatch = path.match(/^\/ingest\/([a-z-]+)$/)
  if (method === 'POST' && ingestMatch) {
    return handleIngest(ingestMatch[1], body)
  }

  if (method === 'GET' && path === '/search') {
    if (!q.q) return { status: 400, body: { ok: false, error: 'q parameter required' } }
    const rows = await queries.searchMessages(q.q, q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  if (method === 'GET' && path === '/sessions') {
    const rows = await queries.listSessions(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  const handoffMatch = path.match(/^\/sessions\/([^/]+)\/handoff$/)
  if (method === 'GET' && handoffMatch) {
    const markdown = await buildHandoff(handoffMatch[1], q)
    if (markdown == null) return { status: 404, body: { ok: false, error: 'Session not found' } }
    if (q.format === 'raw') return { status: 200, contentType: 'text/markdown; charset=utf-8', raw: markdown }
    return { status: 200, body: { ok: true, data: { markdown } } }
  }

  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (method === 'GET' && sessionMatch) {
    const row = await queries.getSession(sessionMatch[1])
    if (!row) return { status: 404, body: { ok: false, error: 'Session not found' } }
    const summary = await queries.getSummary(sessionMatch[1])
    return { status: 200, body: { ok: true, data: { ...row, summary: summary?.summary ?? null } } }
  }

  const msgMatch = path.match(/^\/sessions\/([^/]+)\/messages$/)
  if (method === 'GET' && msgMatch) {
    const rows = await queries.getSessionMessages(msgMatch[1], q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  if (method === 'GET' && path === '/history') {
    const rows = await queries.listHistory(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  if (method === 'GET' && path === '/tasks') {
    const rows = await queries.listTasks(q)
    return { status: 200, body: { ok: true, data: rows } }
  }

  if (method === 'GET' && path === '/sync/status') {
    const rows = await queries.getSyncStatus()
    return { status: 200, body: { ok: true, data: rows } }
  }

  if (method === 'GET' && path === '/stats') {
    const stats = await queries.getStats()
    return { status: 200, body: { ok: true, data: stats } }
  }

  return { status: 404, body: { ok: false, error: 'Not found' } }
}
