import mysql from 'mysql2/promise'
import { messageManifest, manifestDigest, compareManifests } from './sync-verification.js'

// Read-only exact primary-key/content_text comparison for one named host/session.
// Prints identities and hashes, never conversation text or credentials. Extra
// OCI rows are expected under longer retention. This does not verify other
// sessions, metadata, history rows, raw files, or non-text message fields.
const [sessionId, vmId, ...extra] = process.argv.slice(2)
if (!sessionId || !vmId || extra.length) throw new Error('Usage: node scripts/verify-sync-session.js SESSION_ID VM_ID')
const apiToken = process.env.API_TOKEN ?? ''
if (!apiToken) throw new Error('API_TOKEN is required')
const apiUrl = (process.env.OCI_API_URL ?? 'http://127.0.0.1:5002').replace(/\/$/, '')
const maxMessages = Number(process.env.VERIFY_MAX_MESSAGES ?? 20000)
if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100000) throw new Error('VERIFY_MAX_MESSAGES must be 1..100000')

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DORIS_HOST ?? '10.1.0.7', port: Number(process.env.DORIS_PORT ?? 9030),
    user: process.env.DORIS_USER ?? 'root', password: process.env.DORIS_PASSWORD ?? '',
    database: process.env.DORIS_DATABASE ?? 'agent_history', dateStrings: true, connectTimeout: 15000,
  })
  const readSource = async () => {
    const [rows] = await conn.query(
      'SELECT message_id, session_id, vm_id, ts, content_text FROM agent_messages WHERE session_id = ? AND vm_id = ? ORDER BY ts, message_id LIMIT ?',
      [sessionId, vmId, maxMessages + 1],
    )
    if (rows.length > maxMessages) throw new Error('Source session exceeds VERIFY_MAX_MESSAGES; no complete-session claim is possible')
    return messageManifest(rows)
  }
  try {
    const sourceBefore = await readSource()
    if (!sourceBefore.size) throw new Error('Source session has no messages; cannot verify archive coverage')
    const cloudRows = []
    for (;;) {
      const query = new URLSearchParams({ vm_id: vmId, limit: '500', offset: String(cloudRows.length), dialog: '0' })
      const response = await fetch(`${apiUrl}/sessions/${encodeURIComponent(sessionId)}/messages?${query}`, {
        headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(120000),
      })
      if (!response.ok) throw new Error(`Cloud messages request failed: HTTP ${response.status}`)
      const result = await response.json()
      if (result.ok !== true || !Array.isArray(result.data)) throw new Error('Invalid cloud messages response')
      for (const row of result.data) {
        if (row.session_id !== sessionId || row.vm_id !== vmId) throw new Error('Cloud response mixed another host/session')
      }
      cloudRows.push(...result.data)
      if (cloudRows.length > maxMessages) throw new Error('Cloud session exceeds VERIFY_MAX_MESSAGES; no complete-session claim is possible')
      // Read until an empty page, since the server may impose a smaller limit.
      if (!result.data.length) break
    }
    const sourceAfter = await readSource()
    if (manifestDigest(sourceBefore) !== manifestDigest(sourceAfter)) throw new Error('Source session changed during comparison; retry once it is stable')
    const report = compareManifests(sourceBefore, messageManifest(cloudRows))
    console.log(JSON.stringify({
      session_id: sessionId, vm_id: vmId, checkedAt: new Date().toISOString(),
      scope: 'all source-retained message primary keys and content_text in this one session; cloud-only retained rows allowed',
      ...report,
    }, null, 2))
    if (!report.matched) process.exitCode = 2
  } finally {
    await conn.end()
  }
}

main().catch(err => {
  console.error('[verify-sync] inconclusive:', err.message)
  process.exitCode = 1
})
