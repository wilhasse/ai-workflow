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

function validateQuery(q, path) {
  const integer = (name, fallback, minimum, maximum) => {
    if (q[name] === undefined) return fallback
    if (!/^\d+$/.test(q[name])) throw new queries.QueryInputError(`${name} must be an integer`)
    const value = Number(q[name])
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new queries.QueryInputError(`${name} must be between ${minimum} and ${maximum}`)
    return value
  }
  q.limit = integer('limit', path.endsWith('/messages') ? 200 : 50, 1, path.endsWith('/messages') ? 500 : 100)
  q.offset = integer('offset', 0, 0, 100000)
  q.tail = integer('tail', 40, 1, 200)
  for (const [name, maximum] of [['q', 256], ['vm_id', 64], ['source', 16], ['project', 512], ['session_id', 64], ['status', 32]]) {
    if (q[name] !== undefined && (!q[name].trim() || q[name].length > maximum || /[\x00-\x1f]/.test(q[name]))) throw new queries.QueryInputError(`Invalid ${name}`)
  }
  for (const name of ['from', 'to']) {
    if (q[name] !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(q[name]) || !Number.isFinite(Date.parse(q[name])) || new Date(q[name]).toISOString().slice(0, 10) !== q[name])) throw new queries.QueryInputError(`Invalid ${name} date`)
  }
  if (q.from && q.to && q.from > q.to) throw new queries.QueryInputError('from must not be after to')
  if (q.grouped !== undefined && !['0', '1'].includes(q.grouped)) throw new queries.QueryInputError('grouped must be 0 or 1')
  q.grouped = q.grouped === '1'
  if (q.dialog !== undefined && !['0', '1'].includes(q.dialog)) throw new queries.QueryInputError('dialog must be 0 or 1')
  q.dialog = q.dialog === '1'
  if (q.format !== undefined && q.format !== 'raw') throw new queries.QueryInputError('format must be raw')
  return q
}

export async function route(method, url, body) {
  try {
    return await dispatch(method, url, body)
  } catch (error) {
    if (error instanceof queries.QueryInputError) return { status: 400, body: { ok: false, error: error.message } }
    throw error
  }
}

async function dispatch(method, url, body) {
  const path = url.split('?')[0]
  const q = method === 'GET' ? validateQuery(parseQuery(url), path) : parseQuery(url)

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

  if (method === 'GET' && path.startsWith('/sessions/')) {
    const id = path.split('/')[2]
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(id)) throw new queries.QueryInputError('Invalid session id')
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

  const childrenMatch = path.match(/^\/sessions\/([^/]+)\/children$/)
  if (method === 'GET' && childrenMatch) {
    const rows = await queries.listSessionChildren(childrenMatch[1], q)
    if (rows === null) return { status: 404, body: { ok: false, error: 'Session not found' } }
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
    const row = await queries.getSession(sessionMatch[1], q)
    if (!row) return { status: 404, body: { ok: false, error: 'Session not found' } }
    const summary = await queries.getSummary(sessionMatch[1], { vm_id: row.vm_id })
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
