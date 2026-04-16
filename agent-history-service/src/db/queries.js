import { getPool } from './connection.js'

function nowStr() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}

function toDatetime(v) {
  if (!v) return nowStr()
  if (typeof v === 'number') {
    // unix ms or unix s
    const ms = v > 1e12 ? v : v * 1000
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
  }
  if (typeof v === 'string') {
    const d = new Date(v)
    if (isNaN(d.getTime())) return nowStr()
    return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
  }
  return nowStr()
}

function jsonStr(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

// Batch upsert using INSERT INTO ... VALUES ... (Doris unique key model handles dedup)
async function batchUpsert(table, columns, rows) {
  if (!rows.length) return
  const pool = getPool()
  const placeholders = `(${columns.map(() => '?').join(',')})`
  const allPlaceholders = rows.map(() => placeholders).join(',')
  const values = rows.flat()
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${allPlaceholders}`
  await pool.query(sql, values)
}

export async function upsertSessions(records) {
  const cols = ['session_id', 'vm_id', 'started_at', 'source', 'project', 'display_text', 'session_meta', 'message_count', 'last_synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.session_id, r.vm_id, toDatetime(r.started_at),
    r.source, r.project ?? null, r.display_text ?? null,
    jsonStr(r.session_meta), r.message_count ?? 0, now,
  ])
  await batchUpsert('agent_sessions', cols, rows)
}

export async function upsertMessages(records) {
  const cols = ['message_id', 'session_id', 'vm_id', 'ts', 'source', 'msg_type', 'msg_role', 'content_text', 'content_json', 'parent_uuid', 'seq_num']
  const rows = records.map(r => [
    r.message_id, r.session_id, r.vm_id, toDatetime(r.timestamp),
    r.source, r.msg_type ?? 'unknown', r.role ?? '',
    r.content_text ?? null, jsonStr(r.content_json),
    r.parent_uuid ?? null, r.seq_num ?? 0,
  ])
  await batchUpsert('agent_messages', cols, rows)
}

export async function upsertHistory(records) {
  const cols = ['session_id', 'vm_id', 'source', 'ts', 'project', 'display_text', 'pasted_contents']
  const rows = records.map(r => [
    r.session_id, r.vm_id, r.source, toDatetime(r.timestamp),
    r.project ?? null, r.display_text ?? null, jsonStr(r.pasted_contents),
  ])
  await batchUpsert('agent_history', cols, rows)
}

export async function upsertTasks(records) {
  const cols = ['task_id', 'session_id', 'vm_id', 'task_number', 'subject', 'description', 'task_status', 'blocks', 'blocked_by', 'synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.task_id, r.session_id, r.vm_id, r.task_number ?? null,
    r.subject ?? null, r.description ?? null, r.status ?? null,
    jsonStr(r.blocks), jsonStr(r.blocked_by), now,
  ])
  await batchUpsert('agent_tasks', cols, rows)
}

export async function upsertTodos(records) {
  const cols = ['todo_id', 'vm_id', 'content', 'todo_status', 'priority', 'items_json', 'synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.todo_id, r.vm_id, r.content ?? null, r.status ?? null,
    r.priority ?? null, jsonStr(r.items_json), now,
  ])
  await batchUpsert('agent_todos', cols, rows)
}

export async function upsertSyncState(records) {
  const cols = ['vm_id', 'source', 'file_path', 'file_size', 'file_mtime', 'lines_processed', 'last_synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.vm_id, r.source, r.file_path, r.file_size ?? 0,
    toDatetime(r.file_mtime), r.lines_processed ?? 0, now,
  ])
  await batchUpsert('sync_state', cols, rows)
}

// Query helpers for the read API
export function buildSearchMessagesSql(escape, q, { source, vm_id, from, to, limit = 50, offset = 0 } = {}) {
  // Split query on special chars into words, drop short tokens (tokenizer ignores them)
  const words = q.replace(/[._\-/\\]+/g, ' ').trim().split(/\s+/).filter(w => w.length >= 3).join(' ').replace(/'/g, "''")
  let where = `m.content_text MATCH_ALL '${words}'`
  if (source) where += ` AND m.source = ${escape(source)}`
  if (vm_id) where += ` AND m.vm_id = ${escape(vm_id)}`
  if (from) where += ` AND m.ts >= ${escape(from)}`
  if (to) where += ` AND m.ts <= ${escape(to + ' 23:59:59')}`
  return `
    SELECT DISTINCT m.message_id, m.session_id, m.vm_id, m.source, m.msg_role,
           m.content_text, m.ts, m.seq_num,
           NULL AS project,
           NULL AS session_display
    FROM agent_messages m
    WHERE ${where}
    ORDER BY m.ts DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `
}

export async function searchMessages(q, options = {}) {
  const pool = getPool()
  const sql = buildSearchMessagesSql(value => pool.escape(value), q, options)
  const [rows] = await pool.query(sql)
  return rows
}

export async function listSessions({ source, vm_id, project, from, to, limit = 50, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  if (source) conditions.push(`source = ${pool.escape(source)}`)
  if (vm_id) conditions.push(`vm_id = ${pool.escape(vm_id)}`)
  if (project) conditions.push(`project LIKE ${pool.escape('%' + project + '%')}`)
  if (from) conditions.push(`started_at >= ${pool.escape(from)}`)
  if (to) conditions.push(`started_at <= ${pool.escape(to + ' 23:59:59')}`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const sql = `SELECT * FROM agent_sessions ${where} ORDER BY started_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
  const [rows] = await pool.query(sql)
  return rows
}

export async function getSession(sessionId) {
  const pool = getPool()
  const [rows] = await pool.query('SELECT * FROM agent_sessions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1', [sessionId])
  return rows[0] ?? null
}

export async function getSessionMessages(sessionId, { limit = 1000, offset = 0 } = {}) {
  const pool = getPool()
  const sql = `
    SELECT * FROM agent_messages
    WHERE session_id = ?
    ORDER BY seq_num ASC, ts ASC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `
  const [rows] = await pool.query(sql, [sessionId])
  return rows
}

export async function listHistory({ source, vm_id, project, q, limit = 50, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  if (source) conditions.push(`source = ${pool.escape(source)}`)
  if (vm_id) conditions.push(`vm_id = ${pool.escape(vm_id)}`)
  if (project) conditions.push(`project LIKE ${pool.escape('%' + project + '%')}`)
  if (q) conditions.push(`display_text MATCH_ALL '${q.replace(/'/g, "''")}'`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const sql = `SELECT * FROM agent_history ${where} ORDER BY ts DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
  const [rows] = await pool.query(sql)
  return rows
}

export async function listTasks({ session_id, status, q, limit = 100, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  if (session_id) conditions.push(`session_id = ${pool.escape(session_id)}`)
  if (status) conditions.push(`task_status = ${pool.escape(status)}`)
  if (q) conditions.push(`(subject MATCH_ALL '${q.replace(/'/g, "''")}' OR description MATCH_ALL '${q.replace(/'/g, "''")}')`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const sql = `SELECT * FROM agent_tasks ${where} ORDER BY synced_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
  const [rows] = await pool.query(sql)
  return rows
}

export async function getSyncStatus() {
  const pool = getPool()
  const [rows] = await pool.query(`
    SELECT vm_id, source, COUNT(*) as file_count,
           MAX(last_synced_at) as last_sync,
           SUM(lines_processed) as total_lines
    FROM sync_state
    GROUP BY vm_id, source
    ORDER BY last_sync DESC
  `)
  return rows
}

export async function getStats() {
  const pool = getPool()
  const [[files]] = await pool.query('SELECT COUNT(*) as c FROM sync_state')
  const [[sessions]] = await pool.query('SELECT COUNT(*) as c FROM agent_sessions')
  const [[messages]] = await pool.query('SELECT COUNT(*) as c, SUM(LENGTH(content_text) - LENGTH(REPLACE(content_text, \' \', \'\')) + 1) as words FROM agent_messages WHERE content_text IS NOT NULL')
  return {
    files: Number(files.c) || 0,
    sessions: Number(sessions.c) || 0,
    messages: Number(messages.c) || 0,
    words: Number(messages.words) || 0,
  }
}
