import config from './config.js'
import * as watermarks from './watermarks.js'
import { discoverClaudeFiles, discoverCodexFiles } from './file-scanner.js'
import { sendBatched } from './sender.js'
import * as claudeHistory from './parsers/claude-history.js'
import * as claudeSessions from './parsers/claude-sessions.js'
import { parseSessionMeta, parseTasks, parseTodos } from './parsers/claude-metadata.js'
import * as codexHistory from './parsers/codex-history.js'
import * as codexSessions from './parsers/codex-sessions.js'

let syncing = false

// Accumulated sync-state records, flushed in batches at end of cycle
let pendingSyncState = []

function isChanged(file, wm) {
  return file.size !== wm.size
}

function isMtimeChanged(file, wm) {
  if (!wm.mtime) return true
  return new Date(file.mtime).getTime() !== new Date(wm.mtime).getTime()
}

function addSyncState(file, lineCount) {
  pendingSyncState.push({
    vm_id: config.vmId,
    source: file.key.split(':')[0],
    file_path: file.key,
    file_size: file.size,
    file_mtime: file.mtime.toISOString(),
    lines_processed: lineCount,
  })
}

async function processJsonlFile(file, parser) {
  const wm = watermarks.get(file.key)
  if (!isChanged(file, wm)) return 0

  const startLine = wm.lines
  let lineCount = startLine
  const sessionBatch = []
  const messageBatch = []
  const historyBatch = []
  let totalSent = 0

  for await (const record of parser(file.path, startLine)) {
    lineCount++

    if (record._table === 'sessions') {
      delete record._table
      sessionBatch.push(record)
    } else if (record._table === 'messages') {
      delete record._table
      messageBatch.push(record)
    } else {
      historyBatch.push(record)
    }

    if (sessionBatch.length >= config.batchSize) {
      const batch = sessionBatch.splice(0)
      await sendBatched('sessions', batch)
      totalSent += batch.length
    }
    if (messageBatch.length >= config.batchSize) {
      const batch = messageBatch.splice(0)
      await sendBatched('messages', batch)
      totalSent += batch.length
    }
    if (historyBatch.length >= config.batchSize) {
      const batch = historyBatch.splice(0)
      await sendBatched('history', batch)
      totalSent += batch.length
    }
  }

  if (sessionBatch.length) {
    await sendBatched('sessions', sessionBatch)
    totalSent += sessionBatch.length
  }
  if (messageBatch.length) {
    await sendBatched('messages', messageBatch)
    totalSent += messageBatch.length
  }
  if (historyBatch.length) {
    await sendBatched('history', historyBatch)
    totalSent += historyBatch.length
  }

  watermarks.set(file.key, { size: file.size, lines: lineCount, mtime: file.mtime.toISOString() })
  addSyncState(file, lineCount)
  return totalSent
}

async function processJsonFile(file, parser) {
  const wm = watermarks.get(file.key)
  if (!isMtimeChanged(file, wm)) return 0

  const records = []
  for await (const record of parser(file.path)) {
    records.push(record)
  }

  if (!records.length) return 0

  let endpoint
  if (file.type === 'claude-session-meta') endpoint = 'sessions'
  else if (file.type === 'claude-tasks') endpoint = 'tasks'
  else if (file.type === 'claude-todos') endpoint = 'todos'
  else return 0

  await sendBatched(endpoint, records)
  watermarks.set(file.key, { size: file.size, lines: 0, mtime: file.mtime.toISOString() })
  addSyncState(file, 0)
  return records.length
}

async function flushSyncState() {
  if (!pendingSyncState.length) return
  console.log(`[collector] flushing ${pendingSyncState.length} sync-state records`)
  await sendBatched('sync-state', pendingSyncState)
  pendingSyncState = []
}

async function syncCycle() {
  if (syncing) {
    console.log('[collector] sync already in progress, skipping')
    return
  }
  syncing = true
  const start = Date.now()
  let totalFiles = 0
  let totalRecords = 0
  let errors = 0
  pendingSyncState = []

  try {
    const claudeFiles = await discoverClaudeFiles()
    const codexFiles = await discoverCodexFiles()
    const allFiles = [...claudeFiles, ...codexFiles]
    console.log(`[collector] discovered ${allFiles.length} files (${claudeFiles.length} claude, ${codexFiles.length} codex)`)

    for (const file of allFiles) {
      try {
        let count = 0

        switch (file.type) {
          case 'claude-history':
            count = await processJsonlFile(file, claudeHistory.parse)
            break
          case 'claude-session':
            count = await processJsonlFile(file, claudeSessions.parse)
            break
          case 'claude-session-meta':
            count = await processJsonFile(file, parseSessionMeta)
            break
          case 'claude-tasks':
            count = await processJsonFile(file, parseTasks)
            break
          case 'claude-todos':
            count = await processJsonFile(file, parseTodos)
            break
          case 'codex-history':
            count = await processJsonlFile(file, codexHistory.parse)
            break
          case 'codex-session':
            count = await processJsonlFile(file, codexSessions.parse)
            break
        }

        if (count > 0) {
          totalFiles++
          totalRecords += count
        }
      } catch (err) {
        errors++
        console.error(`[collector] error processing ${file.key}:`, err.message)
      }

      // Flush sync-state in batches of 200 to avoid accumulating too many
      if (pendingSyncState.length >= 200) {
        await flushSyncState()
      }
    }

    // Final flush
    await flushSyncState()
    await watermarks.save()
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[collector] sync complete: ${totalFiles} files changed, ${totalRecords} records sent, ${errors} errors (${elapsed}s)`)
  } catch (err) {
    console.error('[collector] sync cycle failed:', err.message)
  } finally {
    syncing = false
  }
}

async function main() {
  console.log(`[collector] starting (vm=${config.vmId}, api=${config.apiUrl}, interval=${config.syncIntervalMs}ms)`)

  try {
    const res = await fetch(`${config.apiUrl}/health`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error)
    console.log('[collector] API connected')
  } catch (err) {
    console.error('[collector] API unreachable:', err.message)
    console.error('[collector] will retry on first sync cycle')
  }

  await watermarks.load()
  await syncCycle()

  setInterval(syncCycle, config.syncIntervalMs)
  console.log(`[collector] scheduled sync every ${config.syncIntervalMs / 1000}s`)
}

main().catch(err => {
  console.error('[collector] fatal:', err)
  process.exit(1)
})
