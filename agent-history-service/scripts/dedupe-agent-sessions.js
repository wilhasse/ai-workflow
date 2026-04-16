#!/usr/bin/env node

import { getPool } from '../src/db/connection.js'
import { collapseSessionRows } from '../src/db/session-dedupe.js'

const SESSION_COLUMNS = [
  'session_id',
  'vm_id',
  'started_at',
  'source',
  'project',
  'display_text',
  'session_meta',
  'message_count',
  'last_synced_at',
]

function parseArgs(argv) {
  const options = {
    apply: false,
    stageTable: 'agent_sessions_dedup_stage',
    backupTable: `agent_sessions_backup_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      options.apply = true
      continue
    }
    if (arg.startsWith('--stage-table=')) {
      options.stageTable = arg.slice('--stage-table='.length)
      continue
    }
    if (arg.startsWith('--backup-table=')) {
      options.backupTable = arg.slice('--backup-table='.length)
    }
  }

  return options
}

function assertIdentifier(name, flag) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`${flag} must use only letters, numbers, and underscores`)
  }
  return name
}

async function insertSessionRows(pool, tableName, rows, batchSize = 500) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize)
    const placeholders = batch.map(() => `(${SESSION_COLUMNS.map(() => '?').join(',')})`).join(',')
    const values = batch.flatMap(row => SESSION_COLUMNS.map(column => row[column] ?? null))
    const sql = `INSERT INTO ${tableName} (${SESSION_COLUMNS.join(',')}) VALUES ${placeholders}`
    await pool.query(sql, values)
  }
}

async function fetchDuplicateStats(pool) {
  const [[stats]] = await pool.query(`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT CONCAT(session_id, '::', vm_id, '::', source)) AS canonical_rows
    FROM agent_sessions
  `)

  const [[groups]] = await pool.query(`
    SELECT
      COUNT(*) AS duplicate_groups,
      COALESCE(SUM(row_count - 1), 0) AS duplicate_rows
    FROM (
      SELECT COUNT(*) AS row_count
      FROM agent_sessions
      GROUP BY session_id, vm_id, source
      HAVING COUNT(*) > 1
    ) grouped
  `)

  return {
    totalRows: Number(stats.total_rows) || 0,
    canonicalRows: Number(stats.canonical_rows) || 0,
    duplicateGroups: Number(groups.duplicate_groups) || 0,
    duplicateRows: Number(groups.duplicate_rows) || 0,
  }
}

async function fetchSampleGroups(pool) {
  const [rows] = await pool.query(`
    SELECT source, vm_id, session_id, COUNT(*) AS row_count,
           MIN(started_at) AS earliest_started_at,
           MAX(started_at) AS latest_started_at
    FROM agent_sessions
    GROUP BY source, vm_id, session_id
    HAVING COUNT(*) > 1
    ORDER BY row_count DESC, latest_started_at DESC
    LIMIT 10
  `)
  return rows
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const stageTable = assertIdentifier(options.stageTable, '--stage-table')
  const backupTable = assertIdentifier(options.backupTable, '--backup-table')
  const pool = getPool()

  const before = await fetchDuplicateStats(pool)
  const samples = await fetchSampleGroups(pool)

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    before,
    samples,
  }, null, 2))

  if (!options.apply) return
  if (before.duplicateGroups === 0) {
    console.log('No duplicate session groups found; nothing to migrate.')
    return
  }

  const [rows] = await pool.query(`
    SELECT ${SESSION_COLUMNS.join(', ')}
    FROM agent_sessions
    ORDER BY session_id ASC, vm_id ASC, source ASC, started_at ASC
  `)

  const canonicalRows = collapseSessionRows(rows)
  if (canonicalRows.length !== before.canonicalRows) {
    throw new Error(`Canonical row count mismatch: expected ${before.canonicalRows}, got ${canonicalRows.length}`)
  }

  await pool.query(`DROP TABLE IF EXISTS ${stageTable}`)
  await pool.query(`CREATE TABLE ${stageTable} LIKE agent_sessions`)
  await insertSessionRows(pool, stageTable, canonicalRows)

  const [[stageCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${stageTable}`)
  if (Number(stageCount.count) !== canonicalRows.length) {
    throw new Error(`Stage table row count mismatch: expected ${canonicalRows.length}, got ${stageCount.count}`)
  }

  await pool.query(`ALTER TABLE agent_sessions REPLACE WITH TABLE ${stageTable} PROPERTIES('swap' = 'true')`)
  await pool.query(`ALTER TABLE ${stageTable} RENAME ${backupTable}`)

  const after = await fetchDuplicateStats(pool)
  console.log(JSON.stringify({
    after,
    backupTable,
  }, null, 2))
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
