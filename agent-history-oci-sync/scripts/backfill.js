import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { TABLES, loadState, saveState, pageQuery, runSync } from './sync-core.js'

// --delta refreshes metadata/history and replays recent messages.
// --reconcile (default) sweeps all retained source messages, resuming across
// bounded runs. It never removes OCI-only archive rows. --max-rows=0 removes
// the row budget; SYNC_MAX_SECONDS=0 also removes the per-run time budget.
const args = process.argv.slice(2)
const mode = args.includes('--delta') ? 'delta' : 'reconcile'
if (args.includes('--delta') && args.includes('--reconcile')) throw new Error('Choose --delta or --reconcile')
for (const arg of args) {
  if (!['--delta', '--reconcile'].includes(arg) && !/^--max-rows=\d+$/.test(arg)) throw new Error(`Unknown argument: ${arg}`)
}

function integer(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = process.env[name] ?? fallback
  if (!/^\d+$/.test(String(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Invalid ${name}`)
  return Number(value)
}

const apiUrl = (process.env.OCI_API_URL ?? 'http://127.0.0.1:5002').replace(/\/$/, '')
const apiToken = process.env.API_TOKEN ?? ''
if (!apiToken) throw new Error('API_TOKEN is required')
const pageSize = integer('BACKFILL_PAGE', 500, 1, 2000)
const stateFile = process.env.BACKFILL_STATE ?? path.join(os.homedir(), '.agent-history-oci-backfill.json')
const overlapHours = integer('SYNC_OVERLAP_HOURS', 48, 1, 8760)
const maxRowsArg = args.find(arg => arg.startsWith('--max-rows='))?.split('=')[1]
const maxRows = maxRowsArg === undefined ? integer('SYNC_MAX_ROWS', mode === 'delta' ? 200000 : 100000, 0) : Number(maxRowsArg)
if (!Number.isSafeInteger(maxRows)) throw new Error('Invalid --max-rows')
const maxSeconds = integer('SYNC_MAX_SECONDS', 600, 0)
const deadline = maxSeconds ? Date.now() + maxSeconds * 1000 : Infinity
const requestTimeout = integer('SYNC_REQUEST_TIMEOUT_MS', 120000, 1000, 600000)
const maxBodyBytes = integer('SYNC_MAX_BODY_BYTES', 4 * 1024 * 1024, 65536, 64 * 1024 * 1024)

async function postBatch(entity, records) {
  // Bound HTTP bodies as well as row counts; conversation messages vary greatly
  // in size. The page cursor advances only after every chunk is acknowledged.
  let batch = []
  let bytes = Buffer.byteLength('{"records":[]}')
  for (const record of records) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record)) + 1
    if (recordBytes + 14 > maxBodyBytes) throw new Error(`One ${entity} record exceeds the ${maxBodyBytes}-byte ingest body budget`)
    if (batch.length && bytes + recordBytes > maxBodyBytes) {
      await postChunk(entity, batch)
      batch = []
      bytes = 14
    }
    batch.push(record)
    bytes += recordBytes
  }
  if (batch.length) await postChunk(entity, batch)
}

async function postChunk(entity, records) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/ingest/${entity}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ records }), signal: AbortSignal.timeout(requestTimeout),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      const result = await response.json()
      if (result.ok !== true || result.inserted !== records.length) throw new Error('Ingest did not acknowledge every record')
      return
    } catch (err) {
      if (attempt === 4) throw new Error(`POST ${entity} failed after ${attempt} attempts: ${err.message}`)
      console.warn(`[sync] POST ${entity} attempt ${attempt} failed; retrying`)
      await new Promise(resolve => setTimeout(resolve, attempt * 2000))
    }
  }
}

async function reportCounts(conn, specs) {
  const response = await fetch(`${apiUrl}/stats`, { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(requestTimeout) })
  if (!response.ok) throw new Error(`Stats request failed: HTTP ${response.status}`)
  const { data: remote } = await response.json()
  console.log('[sync] count observations only; cloud retention and concurrent arrivals prevent these from proving exact coverage')
  for (const spec of specs) {
    const [[row]] = await conn.query(`SELECT COUNT(*) AS c FROM ${spec.table}`)
    const target = Number(remote?.[spec.table])
    if (!Number.isFinite(target)) throw new Error(`Stats response missing ${spec.table}`)
    console.log(`[sync] ${spec.table}: source=${Number(row.c)} cloud=${target}${target < Number(row.c) ? ' (possible outstanding gap or concurrent arrivals)' : ''}`)
  }
}

async function main() {
  const only = process.env.BACKFILL_TABLES?.split(',').map(name => name.trim()).filter(Boolean)
  if (only?.some(name => !TABLES.some(spec => spec.table === name || spec.entity === name))) throw new Error('Unknown BACKFILL_TABLES selection')
  const specs = only
    ? TABLES.filter(spec => only.includes(spec.table) || only.includes(spec.entity))
    : mode === 'delta' ? TABLES : TABLES.filter(spec => spec.entity === 'messages')
  if (!specs.length) throw new Error('No tables selected')
  const state = loadState(stateFile)
  if (state.legacyEventCursors && !Object.keys(state.modes).length) console.log('[sync] migrating legacy cursors; old event-time positions are retained as evidence, not trusted for coverage')
  const conn = await mysql.createConnection({
    host: process.env.DORIS_HOST ?? '10.1.0.7', port: integer('DORIS_PORT', 9030, 1, 65535),
    user: process.env.DORIS_USER ?? 'root', password: process.env.DORIS_PASSWORD ?? '',
    database: process.env.DORIS_DATABASE ?? 'agent_history', dateStrings: true, connectTimeout: 15000,
  })
  try {
    const result = await runSync({
      state, mode, specs, pageSize, maxRows, deadline, overlapHours,
      readUpper: async (spec, lowerBound) => {
        const [rows] = await conn.query(`SELECT ${spec.keys.join(', ')} FROM ${spec.table}${lowerBound ? ' WHERE ts >= ?' : ''} ORDER BY ${spec.keys.map(key => `${key} DESC`).join(', ')} LIMIT 1`, lowerBound ? [lowerBound] : [])
        return rows[0] ?? null
      },
      readPage: async (spec, checkpoint, limit) => {
        const { sql, params } = pageQuery(spec, checkpoint, limit)
        const [rows] = await conn.query(sql, params)
        return rows
      },
      postBatch, persist: current => saveState(stateFile, current), log: message => console.log(`[sync] ${message}`),
    })
    console.log(`[sync] ${mode}: ${result.complete ? 'cycle completed' : `cycle incomplete, checkpoint saved at ${result.table}`}; ${result.rowsAcknowledged} rows acknowledged this run`)
    if (result.complete) await reportCounts(conn, specs)
    console.log('[sync] replay acknowledgements are not an exact content comparison; use verify-sync-session.js for bounded persisted key/text-hash evidence')
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[sync] fatal:', err.message)
  process.exitCode = 1
})
