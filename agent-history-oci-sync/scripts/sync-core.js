import fs from 'node:fs'
import path from 'node:path'

export function formatTimestamp(value) {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

// Doris reports some UTF-8 text fields with a legacy collation. mysql2 then
// decodes non-BMP characters as CESU-8 and replaces each byte. Decode the
// source's UTF-8 bytes explicitly; numeric/date handling remains mysql2's.
export function decodeDorisField(field, next) {
  return ['VAR_STRING', 'STRING', 'VARCHAR', 'BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'TINY_BLOB'].includes(field.type)
    ? field.string('utf8')
    : next()
}

export const TABLES = [
  { entity: 'sessions', table: 'agent_sessions', keys: ['started_at', 'session_id', 'vm_id'], map: r => ({ ...r, started_at: formatTimestamp(r.started_at) }) },
  {
    entity: 'messages', table: 'agent_messages', keys: ['ts', 'session_id', 'vm_id', 'message_id'],
    map: r => ({
      message_id: r.message_id, session_id: r.session_id, vm_id: r.vm_id,
      timestamp: formatTimestamp(r.ts), source: r.source, msg_type: r.msg_type,
      role: r.msg_role, content_text: r.content_text, content_json: r.content_json,
      parent_uuid: r.parent_uuid, seq_num: r.seq_num,
    }),
  },
  { entity: 'history', table: 'agent_history', keys: ['ts', 'session_id', 'vm_id', 'source'], map: r => ({ ...r, timestamp: formatTimestamp(r.ts) }) },
  { entity: 'tasks', table: 'agent_tasks', keys: ['task_id', 'session_id', 'vm_id'], map: r => ({ ...r, status: r.task_status }) },
  { entity: 'todos', table: 'agent_todos', keys: ['todo_id', 'vm_id'], map: r => ({ ...r, status: r.todo_status }) },
  { entity: 'sync-state', table: 'sync_state', keys: ['vm_id', 'source', 'file_path'], map: r => ({ ...r, file_mtime: r.file_mtime ? formatTimestamp(r.file_mtime) : null }) },
]

const tableNames = new Set(TABLES.map(spec => spec.table))
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

export function loadState(filename) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 2, modes: {} }
    throw new Error(`Cannot read sync checkpoint ${filename}: ${err.message}`)
  }
  if (!isObject(state)) throw new Error('Invalid sync checkpoint: expected object')
  if (state.version === undefined && Object.keys(state).every(key => tableNames.has(key) && isObject(state[key]))) {
    // Old event-time cursors cannot prove coverage. Preserve them for diagnosis,
    // but start both new replay modes from their own defined ranges.
    return { version: 2, modes: {}, legacyEventCursors: state }
  }
  if (state.version !== 2 || !isObject(state.modes)) throw new Error('Unsupported sync checkpoint version or structure')
  for (const [mode, value] of Object.entries(state.modes)) {
    if (!['delta', 'reconcile'].includes(mode) || !isObject(value)) throw new Error('Invalid sync checkpoint mode')
    if (!value.cycle) continue
    const cycle = value.cycle
    if (!isObject(cycle) || !validDate(cycle.startedAt) || !Array.isArray(cycle.tables)
      || !cycle.tables.length || cycle.tables.some(name => !tableNames.has(name))
      || new Set(cycle.tables).size !== cycle.tables.length
      || !Number.isInteger(cycle.tableIndex) || cycle.tableIndex < 0 || cycle.tableIndex > cycle.tables.length) {
      throw new Error('Invalid sync checkpoint cycle')
    }
    if (cycle.checkpoint) {
      const spec = TABLES.find(candidate => candidate.table === cycle.tables[cycle.tableIndex])
      const checkpoint = cycle.checkpoint
      const validKey = key => isObject(key) && spec?.keys.every(name => typeof key[name] === 'string')
      if (!spec || !isObject(checkpoint) || !validDate(checkpoint.startedAt)
        || (checkpoint.lowerBound !== null && !validDate(checkpoint.lowerBound))
        || (checkpoint.upperKey !== null && !validKey(checkpoint.upperKey))
        || (checkpoint.lastKey !== null && !validKey(checkpoint.lastKey))
        || !Number.isInteger(checkpoint.rowsAcknowledged) || checkpoint.rowsAcknowledged < 0) {
        throw new Error('Invalid sync table checkpoint')
      }
    }
  }
  return state
}

export function saveState(filename, state) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${process.pid}.tmp`
  let fd
  try {
    fd = fs.openSync(temp, 'w', 0o600)
    fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, filename)
    const directory = fs.openSync(path.dirname(filename), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }
}

export function rowKey(spec, row) {
  return Object.fromEntries(spec.keys.map(key => [key, formatTimestamp(row[key])]))
}

export function keysetWhere(keys, key, direction = '>') {
  if (!['>', '<='].includes(direction)) throw new Error('Invalid keyset direction')
  const operator = direction === '>' ? '>' : '<'
  const terms = []
  const params = []
  for (let i = 0; i < keys.length; i++) {
    terms.push(`(${keys.slice(0, i).map(name => `${name} = ?`).concat(`${keys[i]} ${operator} ?`).join(' AND ')})`)
    for (let j = 0; j <= i; j++) params.push(key[keys[j]])
  }
  if (direction === '<=') {
    terms.push(`(${keys.map(name => `${name} = ?`).join(' AND ')})`)
    params.push(...keys.map(name => key[name]))
  }
  return { where: `(${terms.join(' OR ')})`, params }
}

export function pageQuery(spec, checkpoint, limit) {
  const upper = keysetWhere(spec.keys, checkpoint.upperKey, '<=')
  const conditions = [upper.where]
  const params = [...upper.params]
  if (checkpoint.lastKey) {
    const lower = keysetWhere(spec.keys, checkpoint.lastKey)
    conditions.push(lower.where)
    params.push(...lower.params)
  }
  if (checkpoint.lowerBound) {
    conditions.push('ts >= ?')
    params.push(checkpoint.lowerBound)
  }
  params.push(limit)
  return { sql: `SELECT * FROM ${spec.table} WHERE ${conditions.join(' AND ')} ORDER BY ${spec.keys.join(', ')} LIMIT ?`, params }
}

export async function runSync({ state, mode, specs, pageSize, maxRows, deadline, overlapHours, readUpper, readPage, postBatch, persist, now = () => new Date(), log = () => {} }) {
  const progress = state.modes[mode] ??= {}
  const names = specs.map(spec => spec.table)
  if (!progress.cycle) {
    progress.cycle = { startedAt: now().toISOString(), tables: names, tableIndex: 0, checkpoint: null }
    await persist(state)
  } else if (JSON.stringify(progress.cycle.tables) !== JSON.stringify(names)) {
    throw new Error('Requested tables differ from unfinished cycle; finish it or use another BACKFILL_STATE')
  }
  const cycle = progress.cycle
  let rowsThisRun = 0
  while (cycle.tableIndex < specs.length) {
    if ((maxRows && rowsThisRun >= maxRows) || now().getTime() >= deadline) {
      return { complete: false, rowsAcknowledged: rowsThisRun, table: specs[cycle.tableIndex].table }
    }
    const spec = specs[cycle.tableIndex]
    if (!cycle.checkpoint) {
      const lowerBound = mode === 'delta' && spec.entity === 'messages'
        ? new Date(Date.parse(cycle.startedAt) - overlapHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
        : null
      const upperRow = await readUpper(spec, lowerBound)
      cycle.checkpoint = { startedAt: now().toISOString(), lowerBound, upperKey: upperRow ? rowKey(spec, upperRow) : null, lastKey: null, rowsAcknowledged: 0 }
      await persist(state)
    }
    const checkpoint = cycle.checkpoint
    const limit = maxRows ? Math.min(pageSize, maxRows - rowsThisRun) : pageSize
    const rows = checkpoint.upperKey ? await readPage(spec, checkpoint, limit) : []
    if (rows.length) {
      await postBatch(spec.entity, rows.map(spec.map))
      // A failed acknowledgement leaves the cursor unchanged. A process killed
      // before this atomic write replays an already committed, idempotent page.
      checkpoint.lastKey = rowKey(spec, rows[rows.length - 1])
      checkpoint.rowsAcknowledged += rows.length
      rowsThisRun += rows.length
      await persist(state)
    }
    if (rows.length < limit) {
      log(`${spec.table}: cycle replay acknowledged ${checkpoint.rowsAcknowledged} rows`)
      cycle.tableIndex++
      cycle.checkpoint = null
      await persist(state)
    }
  }
  progress.lastCompletedAt = now().toISOString()
  progress.lastCycleStartedAt = cycle.startedAt
  progress.cycle = null
  await persist(state)
  return { complete: true, rowsAcknowledged: rowsThisRun }
}
