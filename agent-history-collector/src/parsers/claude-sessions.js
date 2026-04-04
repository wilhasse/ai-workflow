import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import config from '../config.js'

// Extracts text from Claude message content (string or array of content blocks)
function extractText(content) {
  if (!content) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n') || null
  }
  return null
}

// Extract project name from file path
// e.g. /home/cslog/.claude/projects/-home-cslog-ai-workflow/session.jsonl → -home-cslog-ai-workflow
function extractProject(filePath) {
  const parts = filePath.split('/projects/')
  if (parts.length < 2) return null
  return parts[1].split('/')[0] ?? null
}

// Parses ~/.claude/projects/{project}/{session}.jsonl
// Types we care about: user, assistant (messages)
// Types we skip: permission-mode, file-history-snapshot, attachment, summary
export async function* parse(filePath, startLine = 0) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const project = extractProject(filePath)
  const sessionId = path.basename(filePath, '.jsonl')
  let lineNum = 0
  let seqNum = 0
  let sessionYielded = false
  let firstTimestamp = null

  for await (const line of rl) {
    lineNum++
    if (lineNum <= startLine) continue
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch { continue }

    const type = rec.type
    if (type !== 'user' && type !== 'assistant') continue

    const msg = rec.message
    if (!msg) continue

    const text = extractText(msg.content)
    const timestamp = rec.timestamp ?? rec.message?.timestamp ?? Date.now()

    if (!firstTimestamp) firstTimestamp = timestamp

    // Yield session record once
    if (!sessionYielded) {
      sessionYielded = true
      yield {
        _table: 'sessions',
        session_id: sessionId,
        vm_id: config.vmId,
        source: 'claude',
        project,
        started_at: timestamp,
        display_text: text ? text.slice(0, 200) : null,
        session_meta: null,
        message_count: 0,
      }
    }

    seqNum++
    yield {
      _table: 'messages',
      message_id: rec.uuid ?? rec.promptId ?? randomUUID(),
      session_id: sessionId,
      vm_id: config.vmId,
      source: 'claude',
      msg_type: type,
      role: msg.role ?? type,
      content_text: text,
      content_json: msg.content,
      parent_uuid: rec.parentUuid ?? null,
      timestamp,
      seq_num: seqNum,
    }
  }
}
