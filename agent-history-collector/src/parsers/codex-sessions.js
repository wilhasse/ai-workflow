import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import config from '../config.js'

function extractText(content) {
  if (!content) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => (b.type === 'input_text' || b.type === 'text' || b.type === 'output_text') && b.text)
      .map(b => b.text)
      .join('\n') || null
  }
  return null
}

// Extract session ID from codex session filename
// e.g. rollout-2026-04-04T11-55-51-019d58fe-43f7-75e2-9261-ca70651b8fe2.jsonl
function extractSessionId(filePath) {
  const base = path.basename(filePath, '.jsonl')
  // Session ID is the UUID at the end after the timestamp
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return match?.[1] ?? base
}

// Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Types: session_meta, response_item (user/assistant messages), event_msg, turn_context
export async function* parse(filePath, startLine = 0) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const sessionId = extractSessionId(filePath)
  let lineNum = 0
  let seqNum = 0
  let sessionYielded = false

  for await (const line of rl) {
    lineNum++
    if (lineNum <= startLine) continue
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch { continue }

    const type = rec.type
    const payload = rec.payload
    const timestamp = rec.timestamp ?? new Date().toISOString()

    // Handle session_meta — yields a session record
    if (type === 'session_meta' && !sessionYielded) {
      sessionYielded = true
      yield {
        _table: 'sessions',
        session_id: payload?.id ?? sessionId,
        vm_id: config.vmId,
        source: 'codex',
        project: payload?.cwd ?? null,
        started_at: payload?.timestamp ?? timestamp,
        display_text: null,
        session_meta: {
          cwd: payload?.cwd,
          originator: payload?.originator,
          cli_version: payload?.cli_version,
          model_provider: payload?.model_provider,
          source: payload?.source,
        },
        message_count: 0,
      }
      continue
    }

    // Handle response_item with role user or assistant
    if (type === 'response_item' && payload) {
      const role = payload.role
      if (role !== 'user' && role !== 'assistant') continue

      const text = extractText(payload.content)
      if (!text) continue

      seqNum++
      yield {
        _table: 'messages',
        message_id: payload.id ?? randomUUID(),
        session_id: sessionId,
        vm_id: config.vmId,
        source: 'codex',
        msg_type: payload.type ?? 'message',
        role,
        content_text: text,
        content_json: payload.content,
        parent_uuid: null,
        timestamp,
        seq_num: seqNum,
      }
    }
  }
}
