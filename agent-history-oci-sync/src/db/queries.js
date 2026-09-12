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
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
    const d = new Date(normalized)
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
    .map(c => c === 'last_activity' ? `last_activity = GREATEST(COALESCE(${table}.last_activity, new.last_activity), new.last_activity)` : `${c} = new.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${allPlaceholders} AS new ON DUPLICATE KEY UPDATE ${updates}`
  await pool.query(sql, rows.flat())
}

export async function upsertSessions(records) {
  const cols = ['session_id', 'vm_id', 'started_at', 'source', 'project', 'display_text', 'session_meta', 'message_count', 'last_synced_at', 'last_activity']
  const now = nowStr()
  const rows = records.map(r => [
    r.session_id, r.vm_id, toDatetime(r.started_at),
    truncate(r.source, 16) ?? '', truncate(r.project, 512), r.display_text ?? null,
    jsonStr(r.session_meta), r.message_count ?? 0, now, toDatetime(r.last_activity ?? r.started_at),
  ])
  await batchUpsert('agent_sessions', ['session_id', 'vm_id', 'started_at'], cols, rows)
  if (rows.length) {
    await getPool().query(
      `UPDATE agent_sessions s JOIN (
         SELECT session_id, vm_id, MAX(last_activity) AS latest FROM agent_sessions
         WHERE (session_id, vm_id) IN (${rows.map(() => '(?, ?)').join(',')})
         GROUP BY session_id, vm_id
       ) activity ON activity.session_id = s.session_id AND activity.vm_id = s.vm_id
       SET s.last_activity = GREATEST(COALESCE(s.last_activity, activity.latest), activity.latest)`,
      rows.flatMap(row => [row[0], row[1]]),
    )
  }
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
  const activity = new Map()
  for (const row of rows) {
    const [, sessionId, host, timestamp, source] = row
    const key = JSON.stringify([sessionId, host])
    const previous = activity.get(key)
    activity.set(key, {
      sessionId, host, source,
      first: previous && previous.first < timestamp ? previous.first : timestamp,
      last: previous && previous.last > timestamp ? previous.last : timestamp,
    })
  }
  for (const { sessionId, host, source, first, last } of activity.values()) {
    await getPool().query(
      `INSERT INTO agent_sessions (session_id, vm_id, started_at, source, message_count, last_synced_at, last_activity, session_meta)
       SELECT ?, ?, ?, ?, 0, ?, ?, '{"message_derived":true}' FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM agent_sessions WHERE session_id = ? AND vm_id = ?)
       ON DUPLICATE KEY UPDATE last_activity = GREATEST(COALESCE(last_activity, ?), ?)`,
      [sessionId, host, first, source, nowStr(), last, sessionId, host, last, last],
    )
    await getPool().query(
      `UPDATE agent_sessions SET last_activity = GREATEST(COALESCE(last_activity, ?), ?)
       WHERE session_id = ? AND vm_id = ?`,
      [last, last, sessionId, host],
    )
  }
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

export class QueryInputError extends Error {}

export async function resolveSessionHost(sessionId, vmId) {
  if (vmId) return vmId
  const [hosts] = await getPool().query(
    `SELECT vm_id FROM agent_sessions WHERE session_id = ?
     UNION SELECT vm_id FROM agent_messages WHERE session_id = ? LIMIT 2`,
    [sessionId, sessionId],
  )
  if (hosts.length > 1) throw new QueryInputError('vm_id is required for a session stored on multiple hosts')
  return hosts[0]?.vm_id ?? null
}

// Match the dashboard's conversationPresentation injected-context prefixes.
const injectedPrefixes = ['# AGENTS.md instructions', '<environment_context>', '<recommended_plugins>', '<skills_instructions>', '<permissions instructions>', '<developer_instructions>', '<developer>']
const substantivePrompt = injectedPrefixes.map(prefix => `LEFT(REGEXP_REPLACE(m.content_text, '^[[:space:]]+', ''), ${prefix.length}) <> '${prefix}'`).join(' AND ')
const isInjected = text => injectedPrefixes.some(prefix => String(text ?? '').trimStart().startsWith(prefix))

function presentSession(row) {
  let meta = {}
  try { meta = typeof row.session_meta === 'string' ? JSON.parse(row.session_meta) : row.session_meta ?? {} } catch {}
  const title = [meta?.conversationTitle, meta?.conversation_title, meta?.title, row.display_text, row.first_prompt].find(value => typeof value === 'string' && value.trim() && !isInjected(value)) || row.session_id
  return {
    ...row,
    title: String(title).split('\n')[0].slice(0, 240),
    display_text: title,
    last_activity: row.last_activity || row.started_at,
    message_count: Number(row.message_count) || 0,
  }
}

export async function searchMessages(q, { source, vm_id, project, from, to, limit = 50, offset = 0, dialog = false } = {}) {
  const params = [q, q]
  let where = 'MATCH(m.content_text) AGAINST (? IN NATURAL LANGUAGE MODE)'
  if (source) { where += ' AND m.source = ?'; params.push(source) }
  if (vm_id) { where += ' AND m.vm_id = ?'; params.push(vm_id) }
  if (project) {
    where += ` AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.session_id = m.session_id AND s.vm_id = m.vm_id AND s.project LIKE ?)`
    params.push(`%${project}%`)
  }
  if (from) { where += ' AND m.ts >= ?'; params.push(from) }
  if (to) { where += ' AND m.ts <= ?'; params.push(`${to} 23:59:59`) }
  if (dialog) where += " AND m.msg_role IN ('user', 'assistant')"
  params.push(Number(limit), Number(offset))
  const [rows] = await getPool().query(
    `SELECT hits.*,
       (SELECT s.project FROM agent_sessions s WHERE s.session_id = hits.session_id AND s.vm_id = hits.vm_id ORDER BY COALESCE(s.session_meta = '{"message_derived":true}', 0), s.started_at DESC LIMIT 1) AS project,
       (SELECT LEFT(s.display_text, 240) FROM agent_sessions s WHERE s.session_id = hits.session_id AND s.vm_id = hits.vm_id ORDER BY COALESCE(s.session_meta = '{"message_derived":true}', 0), s.started_at DESC LIMIT 1) AS session_display
     FROM (
       SELECT m.message_id, m.session_id, m.vm_id, m.source, m.msg_role,
         m.content_text, m.ts, m.seq_num,
         MATCH(m.content_text) AGAINST (? IN NATURAL LANGUAGE MODE) AS relevance
       FROM agent_messages m WHERE ${where}
       ORDER BY relevance DESC, m.ts DESC, m.message_id ASC, m.session_id ASC, m.vm_id ASC LIMIT ? OFFSET ?
     ) hits ORDER BY hits.relevance DESC, hits.ts DESC, hits.message_id ASC, hits.session_id ASC, hits.vm_id ASC`,
    params,
  )
  return rows
}

export async function listSessions({ source, vm_id, project, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = []
  const params = []
  if (source) { conditions.push('s.source = ?'); params.push(source) }
  if (vm_id) { conditions.push('s.vm_id = ?'); params.push(vm_id) }
  if (project) { conditions.push('s.project LIKE ?'); params.push(`%${project}%`) }
  if (from) { conditions.push('s.last_activity >= ?'); params.push(from) }
  if (to) { conditions.push('s.last_activity <= ?'); params.push(`${to} 23:59:59`) }
  conditions.push(`NOT EXISTS (SELECT 1 FROM agent_sessions newer WHERE newer.session_id = s.session_id AND newer.vm_id = s.vm_id AND (
    (COALESCE(newer.session_meta, '') <> '{"message_derived":true}' AND s.session_meta = '{"message_derived":true}') OR
    ((COALESCE(newer.session_meta = '{"message_derived":true}', 0) = COALESCE(s.session_meta = '{"message_derived":true}', 0)) AND newer.started_at > s.started_at)
  ))`)
  params.push(Number(limit), Number(offset))
  const [rows] = await getPool().query(
    `SELECT page.*,
       (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = page.session_id AND m.vm_id = page.vm_id) AS message_count,
       COALESCE(page.last_activity, page.started_at) AS last_activity,
       (SELECT LEFT(m.content_text, 512) FROM agent_messages m WHERE m.session_id = page.session_id AND m.vm_id = page.vm_id AND m.msg_role = 'user' AND m.content_text <> '' AND ${substantivePrompt} ORDER BY m.seq_num, m.ts, m.message_id LIMIT 1) AS first_prompt,
       EXISTS (SELECT 1 FROM session_summaries sm WHERE sm.session_id = page.session_id AND sm.vm_id = page.vm_id AND sm.summary IS NOT NULL) AS has_summary
     FROM (
       SELECT s.* FROM agent_sessions s WHERE ${conditions.join(' AND ')}
       ORDER BY s.last_activity DESC, s.session_id, s.vm_id LIMIT ? OFFSET ?
     ) page ORDER BY page.last_activity DESC, page.session_id, page.vm_id`,
    params,
  )
  return rows.map(presentSession)
}

export async function getSession(sessionId, { vm_id } = {}) {
  const host = await resolveSessionHost(sessionId, vm_id)
  if (!host) return null
  const [rows] = await getPool().query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.session_id AND m.vm_id = s.vm_id) AS message_count,
       COALESCE(s.last_activity, s.started_at) AS last_activity,
       (SELECT LEFT(m.content_text, 512) FROM agent_messages m WHERE m.session_id = s.session_id AND m.vm_id = s.vm_id AND m.msg_role = 'user' AND m.content_text <> '' AND ${substantivePrompt} ORDER BY m.seq_num, m.ts, m.message_id LIMIT 1) AS first_prompt
     FROM agent_sessions s WHERE s.session_id = ? AND s.vm_id = ? ORDER BY COALESCE(s.session_meta = '{"message_derived":true}', 0), s.started_at DESC LIMIT 1`,
    [sessionId, host],
  )
  return rows[0] ? presentSession(rows[0]) : null
}

export async function getSessionMessages(sessionId, { vm_id, limit = 200, offset = 0, dialog = false, recent = false } = {}) {
  const host = await resolveSessionHost(sessionId, vm_id)
  if (!host) return []
  const direction = recent ? 'DESC' : 'ASC'
  const [rows] = await getPool().query(
    `SELECT * FROM agent_messages
     WHERE session_id = ? AND vm_id = ?${dialog ? " AND msg_role IN ('user', 'assistant') AND content_text IS NOT NULL AND content_text <> ''" : ''}
     ORDER BY seq_num ${direction}, ts ${direction}, message_id ${direction}
     LIMIT ? OFFSET ?`,
    [sessionId, host, Number(limit), Number(offset)],
  )
  return recent ? rows.reverse() : rows
}

export async function getSummary(sessionId, { vm_id } = {}) {
  const host = await resolveSessionHost(sessionId, vm_id)
  if (!host) return null
  const [rows] = await getPool().query(
    'SELECT * FROM session_summaries WHERE session_id = ? AND vm_id = ? LIMIT 1',
    [sessionId, host],
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
