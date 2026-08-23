import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'

// One-time backfill: streams Doris agent_history tables (all vm_ids) into the
// OCI ingest API in batches. Resumable via a watermark file; safe to re-run
// because ingest upserts are idempotent. Verifies per-table counts at the end.
//
// Usage:
//   OCI_API_URL=http://127.0.0.1:5002 API_TOKEN=... node scripts/backfill.js
// (point OCI_API_URL at an SSH tunnel to the VM, or at the HTTPS domain)

const DORIS = {
  host: process.env.DORIS_HOST ?? '10.1.0.7',
  port: Number.parseInt(process.env.DORIS_PORT ?? '9030', 10),
  user: process.env.DORIS_USER ?? 'root',
  password: process.env.DORIS_PASSWORD ?? '',
  database: process.env.DORIS_DATABASE ?? 'agent_history',
}
const API_URL = (process.env.OCI_API_URL ?? 'http://127.0.0.1:5002').replace(/\/$/, '')
const API_TOKEN = process.env.API_TOKEN ?? ''
const PAGE = Number.parseInt(process.env.BACKFILL_PAGE ?? '2000', 10)
const STATE_FILE = process.env.BACKFILL_STATE ?? path.join(os.homedir(), '.agent-history-oci-backfill.json')

// entity, source table, keyset columns (used for resume), row mapper
const TABLES = [
  {
    entity: 'sessions',
    table: 'agent_sessions',
    keys: ['started_at', 'session_id', 'vm_id'],
    map: r => ({ ...r, started_at: fmtTs(r.started_at) }),
  },
  {
    entity: 'messages',
    table: 'agent_messages',
    keys: ['ts', 'session_id', 'vm_id', 'message_id'],
    map: r => ({
      message_id: r.message_id,
      session_id: r.session_id,
      vm_id: r.vm_id,
      timestamp: fmtTs(r.ts),
      source: r.source,
      msg_type: r.msg_type,
      role: r.msg_role,
      content_text: r.content_text,
      content_json: r.content_json,
      parent_uuid: r.parent_uuid,
      seq_num: r.seq_num,
    }),
  },
  {
    entity: 'history',
    table: 'agent_history',
    keys: ['ts', 'session_id', 'vm_id', 'source'],
    map: r => ({ ...r, timestamp: fmtTs(r.ts) }),
  },
  {
    entity: 'tasks',
    table: 'agent_tasks',
    keys: ['task_id', 'session_id', 'vm_id'],
    map: r => ({ ...r, status: r.task_status }),
    fullReload: true,
  },
  {
    entity: 'todos',
    table: 'agent_todos',
    keys: ['todo_id', 'vm_id'],
    map: r => ({ ...r, status: r.todo_status }),
    fullReload: true,
  },
  {
    entity: 'sync-state',
    table: 'sync_state',
    keys: ['vm_id', 'source', 'file_path'],
    map: r => ({ ...r, file_mtime: r.file_mtime ? fmtTs(r.file_mtime) : null }),
    fullReload: true,
  },
]

function fmtTs(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function keysetWhere(keys, last) {
  // (k1 > ?) OR (k1 = ? AND k2 > ?) OR ...
  const ors = []
  const params = []
  for (let i = 0; i < keys.length; i++) {
    const eqs = keys.slice(0, i).map(k => `${k} = ?`).join(' AND ')
    ors.push(eqs ? `(${eqs} AND ${keys[i]} > ?)` : `(${keys[i]} > ?)`)
    for (let j = 0; j <= i; j++) params.push(last[keys[j]])
  }
  return { where: ors.join(' OR '), params }
}

async function postBatch(entity, records) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API_URL}/ingest/${entity}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        },
        body: JSON.stringify({ records }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return
    } catch (err) {
      if (attempt === 4) throw err
      const wait = attempt * 2000
      console.warn(`[backfill] POST ${entity} attempt ${attempt} failed (${err.message}); retrying in ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

async function backfillTable(conn, spec, state) {
  // Mutable tables (rows update in place, new keys can sort anywhere) must be
  // re-read in full each run; keyset resume only works for append-only tables.
  const last = spec.fullReload ? null : state[spec.table]
  const orderBy = spec.keys.join(', ')
  let total = 0
  let cursor = last
  for (;;) {
    let sql = `SELECT * FROM ${spec.table}`
    let params = []
    if (cursor) {
      const { where, params: p } = keysetWhere(spec.keys, cursor)
      sql += ` WHERE ${where}`
      params = p
    }
    sql += ` ORDER BY ${orderBy} LIMIT ${PAGE}`
    const [rows] = await conn.query(sql, params)
    if (!rows.length) break
    const records = rows.map(spec.map)
    await postBatch(spec.entity, records)
    total += records.length
    const tail = rows[rows.length - 1]
    cursor = {}
    for (const k of spec.keys) cursor[k] = fmtTs(tail[k])
    if (!spec.fullReload) {
      state[spec.table] = cursor
      saveState(state)
    }
    if (total % (PAGE * 10) === 0 || rows.length < PAGE) {
      console.log(`[backfill] ${spec.table}: ${total} rows sent`)
    }
    if (rows.length < PAGE) break
  }
  console.log(`[backfill] ${spec.table} done: ${total} rows`)
  return total
}

async function verifyCounts(conn, state) {
  const res = await fetch(`${API_URL}/stats`, {
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
  })
  if (!res.ok) throw new Error(`stats failed: HTTP ${res.status}`)
  const { data: remote } = await res.json()
  console.log('[backfill] count verification (doris vs oci):')
  let mismatch = false
  for (const spec of TABLES) {
    const [[row]] = await conn.query(`SELECT COUNT(*) AS c FROM ${spec.table}`)
    const local = Number(row.c)
    const remoteCount = Number(remote[spec.table] ?? -1)
    // Doris prunes old data while OCI retains it, so oci > doris is expected
    // after the initial load; only oci < doris signals a real gap.
    const flag = remoteCount >= local ? 'OK' : 'MISMATCH'
    if (remoteCount < local) mismatch = true
    console.log(`  ${spec.table}: doris=${local} oci=${remoteCount} ${flag}`)
  }
  return !mismatch
}

async function main() {
  const only = process.env.BACKFILL_TABLES?.split(',')
  const specs = only ? TABLES.filter(t => only.includes(t.table) || only.includes(t.entity)) : TABLES
  const conn = await mysql.createConnection({ ...DORIS, dateStrings: true })
  const state = loadState()
  try {
    for (const spec of specs) {
      await backfillTable(conn, spec, state)
    }
    const ok = await verifyCounts(conn, state)
    if (!ok) {
      console.error('[backfill] count mismatch detected; re-run to top up (idempotent)')
      process.exit(2)
    }
    console.log('[backfill] complete, counts match')
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[backfill] fatal:', err)
  process.exit(1)
})
