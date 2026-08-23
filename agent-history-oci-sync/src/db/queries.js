import { getPool } from './connection.js'

function nowStr() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
}

function toDatetime(v) {
  if (!v) return nowStr()
  if (typeof v === 'number') {
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

function truncate(v, max) {
  if (typeof v !== 'string') return v
  return v.length > max ? v.slice(0, max) : v
}

// Idempotent batch upsert: replaying the same batch never duplicates rows.
async function batchUpsert(table, keyCols, cols, rows) {
  if (!rows.length) return
  const pool = getPool()
  const placeholders = `(${cols.map(() => '?').join(',')})`
  const allPlaceholders = rows.map(() => placeholders).join(',')
  const updates = cols
    .filter(c => !keyCols.includes(c))
    .map(c => `${c} = new.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${allPlaceholders} AS new ON DUPLICATE KEY UPDATE ${updates}`
  await pool.query(sql, rows.flat())
}

export async function upsertSessions(records) {
  const cols = ['session_id', 'vm_id', 'started_at', 'source', 'project', 'display_text', 'session_meta', 'message_count', 'last_synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.session_id, r.vm_id, toDatetime(r.started_at),
    truncate(r.source, 16) ?? '', truncate(r.project, 512), r.display_text ?? null,
    jsonStr(r.session_meta), r.message_count ?? 0, now,
  ])
  await batchUpsert('agent_sessions', ['session_id', 'vm_id', 'started_at'], cols, rows)
}

export async function upsertMessages(records) {
  const cols = ['message_id', 'session_id', 'vm_id', 'ts', 'source', 'msg_type', 'msg_role', 'content_text', 'content_json', 'parent_uuid', 'seq_num']
  const rows = records.map(r => [
    r.message_id, r.session_id, r.vm_id, toDatetime(r.timestamp ?? r.ts),
    truncate(r.source, 16) ?? '', truncate(r.msg_type ?? 'unknown', 32), truncate(r.role ?? r.msg_role ?? '', 16),
    r.content_text ?? null, jsonStr(r.content_json),
    r.parent_uuid ?? null, r.seq_num ?? 0,
  ])
  await batchUpsert('agent_messages', ['message_id', 'session_id', 'vm_id', 'ts'], cols, rows)
}

export async function upsertHistory(records) {
  const cols = ['session_id', 'vm_id', 'source', 'ts', 'project', 'display_text', 'pasted_contents']
  const rows = records.map(r => [
    r.session_id, r.vm_id, truncate(r.source, 16) ?? '', toDatetime(r.timestamp ?? r.ts),
    truncate(r.project, 512), r.display_text ?? null, jsonStr(r.pasted_contents),
  ])
  await batchUpsert('agent_history', ['session_id', 'vm_id', 'source', 'ts'], cols, rows)
}

export async function upsertTasks(records) {
  const cols = ['task_id', 'session_id', 'vm_id', 'task_number', 'subject', 'description', 'task_status', 'blocks', 'blocked_by', 'synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.task_id, r.session_id, r.vm_id, r.task_number ?? null,
    r.subject ?? null, r.description ?? null, truncate(r.status ?? r.task_status, 32),
    jsonStr(r.blocks), jsonStr(r.blocked_by), now,
  ])
  await batchUpsert('agent_tasks', ['task_id', 'session_id', 'vm_id'], cols, rows)
}

export async function upsertTodos(records) {
  const cols = ['todo_id', 'vm_id', 'content', 'todo_status', 'priority', 'items_json', 'synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.todo_id, r.vm_id, r.content ?? null, truncate(r.status ?? r.todo_status, 32),
    truncate(r.priority, 16), jsonStr(r.items_json), now,
  ])
  await batchUpsert('agent_todos', ['todo_id', 'vm_id'], cols, rows)
}

export async function upsertSyncState(records) {
  const cols = ['vm_id', 'source', 'file_path', 'file_size', 'file_mtime', 'lines_processed', 'last_synced_at']
  const now = nowStr()
  const rows = records.map(r => [
    r.vm_id, truncate(r.source, 16), truncate(r.file_path, 512), r.file_size ?? 0,
    r.file_mtime ? toDatetime(r.file_mtime) : null, r.lines_processed ?? 0, now,
  ])
  await batchUpsert('sync_state', ['vm_id', 'source', 'file_path'], cols, rows)
}

export async function upsertSummary({ session_id, vm_id, summary, model, msg_count, last_message_ts }) {
  const pool = getPool()
  await pool.query(
    `INSERT INTO session_summaries (session_id, vm_id, summary, model, msg_count, last_message_ts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       summary = new.summary, model = new.model, msg_count = new.msg_count,
       last_message_ts = new.last_message_ts, updated_at = new.updated_at`,
    [session_id, vm_id, summary, model, msg_count, last_message_ts, nowStr()],
  )
}

// Read API

export async function searchMessages(q, { source, vm_id, project, from, to, limit = 50, offset = 0 } = {}) {
  const pool = getPool()
  const params = [q, `%${q}%`]
  let where = '(MATCH(m.content_text) AGAINST (? IN NATURAL LANGUAGE MODE) OR m.content_text LIKE ?)'
  if (source) { where += ' AND m.source = ?'; params.push(source) }
  if (vm_id) { where += ' AND m.vm_id = ?'; params.push(vm_id) }
  if (project) { where += ' AND s.project LIKE ?'; params.push(`%${project}%`) }
  if (from) { where += ' AND m.ts >= ?'; params.push(from) }
  if (to) { where += ' AND m.ts <= ?'; params.push(`${to} 23:59:59`) }
  params.push(Number(limit), Number(offset))
  const [rows] = await pool.query(
    `SELECT m.message_id, m.session_id, m.vm_id, m.source, m.msg_role,
            m.content_text, m.ts, m.seq_num, s.project, s.display_text AS session_display,
            MATCH(m.content_text) AGAINST (?) AS relevance
     FROM agent_messages m
     LEFT JOIN (
       SELECT session_id, vm_id, MAX(project) AS project, MAX(display_text) AS display_text
       FROM agent_sessions GROUP BY session_id, vm_id
     ) s ON s.session_id = m.session_id AND s.vm_id = m.vm_id
     WHERE ${where}
     ORDER BY relevance DESC, m.ts DESC
     LIMIT ? OFFSET ?`,
    [q, ...params],
  )
  return rows
}

export async function listSessions({ source, vm_id, project, from, to, limit = 50, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  const params = []
  if (source) { conditions.push('s.source = ?'); params.push(source) }
  if (vm_id) { conditions.push('s.vm_id = ?'); params.push(vm_id) }
  if (project) { conditions.push('s.project LIKE ?'); params.push(`%${project}%`) }
  if (from) { conditions.push('s.started_at >= ?'); params.push(from) }
  if (to) { conditions.push('s.started_at <= ?'); params.push(`${to} 23:59:59`) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(Number(limit), Number(offset))
  const [rows] = await pool.query(
    `SELECT s.*, sm.summary IS NOT NULL AS has_summary
     FROM agent_sessions s
     LEFT JOIN session_summaries sm
       ON sm.session_id = s.session_id AND sm.vm_id = s.vm_id
     ${where}
     ORDER BY s.started_at DESC
     LIMIT ? OFFSET ?`,
    params,
  )
  return rows
}

export async function getSession(sessionId) {
  const pool = getPool()
  const [rows] = await pool.query(
    'SELECT * FROM agent_sessions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1',
    [sessionId],
  )
  return rows[0] ?? null
}

export async function getSessionMessages(sessionId, { limit = 1000, offset = 0 } = {}) {
  const pool = getPool()
  const [rows] = await pool.query(
    `SELECT * FROM agent_messages
     WHERE session_id = ?
     ORDER BY seq_num ASC, ts ASC
     LIMIT ? OFFSET ?`,
    [sessionId, Number(limit), Number(offset)],
  )
  return rows
}

export async function getSummary(sessionId) {
  const pool = getPool()
  const [rows] = await pool.query(
    'SELECT * FROM session_summaries WHERE session_id = ? LIMIT 1',
    [sessionId],
  )
  return rows[0] ?? null
}

export async function listHistory({ source, vm_id, project, q, limit = 50, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  const params = []
  if (source) { conditions.push('source = ?'); params.push(source) }
  if (vm_id) { conditions.push('vm_id = ?'); params.push(vm_id) }
  if (project) { conditions.push('project LIKE ?'); params.push(`%${project}%`) }
  if (q) { conditions.push('MATCH(display_text) AGAINST (? IN NATURAL LANGUAGE MODE)'); params.push(q) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(Number(limit), Number(offset))
  const [rows] = await pool.query(
    `SELECT * FROM agent_history ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
    params,
  )
  return rows
}

export async function listTasks({ session_id, status, q, limit = 100, offset = 0 } = {}) {
  const pool = getPool()
  const conditions = []
  const params = []
  if (session_id) { conditions.push('session_id = ?'); params.push(session_id) }
  if (status) { conditions.push('task_status = ?'); params.push(status) }
  if (q) { conditions.push('MATCH(subject, description) AGAINST (? IN NATURAL LANGUAGE MODE)'); params.push(q) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(Number(limit), Number(offset))
  const [rows] = await pool.query(
    `SELECT * FROM agent_tasks ${where} ORDER BY synced_at DESC LIMIT ? OFFSET ?`,
    params,
  )
  return rows
}

export async function getSyncStatus() {
  const pool = getPool()
  const [rows] = await pool.query(
    `SELECT vm_id, source, COUNT(*) AS file_count,
            MAX(last_synced_at) AS last_sync,
            SUM(lines_processed) AS total_lines
     FROM sync_state
     GROUP BY vm_id, source
     ORDER BY last_sync DESC`,
  )
  return rows
}

export async function getStats() {
  const pool = getPool()
  const tables = ['sync_state', 'agent_sessions', 'agent_messages', 'agent_history', 'agent_tasks', 'agent_todos', 'session_summaries']
  const stats = {}
  for (const table of tables) {
    const [[row]] = await pool.query(`SELECT COUNT(*) AS c FROM ${table}`)
    stats[table] = Number(row.c) || 0
  }
  const [[size]] = await pool.query(
    `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) AS mb
     FROM information_schema.tables WHERE table_schema = DATABASE()`,
  )
  stats.total_mb = Number(size.mb) || 0
  return stats
}
