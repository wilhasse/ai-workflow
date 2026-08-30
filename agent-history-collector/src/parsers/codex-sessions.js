import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
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

function isInjectedUserContext(text) {
  const value = String(text || '').trimStart()
  return [
    '# AGENTS.md instructions',
    '<environment_context>',
    '<recommended_plugins>',
    '<skills_instructions>',
    '<permissions instructions>',
  ].some(prefix => value.startsWith(prefix))
}

function extractSessionId(filePath) {
  const base = path.basename(filePath, '.jsonl')
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return match?.[1] ?? base
}

export async function* parse(filePath, startLine = 0, onLine = () => {}) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const sessionId = extractSessionId(filePath)
  let lineNum = 0
  let sessionYielded = false
  let turnStarted = false
  let pendingUser = null

  const messageRecord = ({ payload, role, text, timestamp }) => ({
    _table: 'messages',
    message_id: payload.id ?? `${sessionId}:line:${lineNum}`,
    session_id: sessionId,
    vm_id: config.vmId,
    source: 'codex',
    msg_type: payload.type ?? 'message',
    role,
    content_text: text,
    content_json: payload.content,
    parent_uuid: null,
    timestamp,
    seq_num: lineNum,
  })

  for await (const line of rl) {
    lineNum++
    onLine(lineNum)
    if (lineNum <= startLine) continue
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch { continue }

    const type = rec.type
    const payload = rec.payload
    const timestamp = rec.timestamp ?? new Date().toISOString()

    if (type === 'turn_context') {
      if (pendingUser) yield pendingUser
      pendingUser = null
      turnStarted = true
      continue
    }

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

    if (type === 'response_item' && payload) {
      const role = payload.role
      if (role !== 'user' && role !== 'assistant') continue

      const text = extractText(payload.content)
      if (!text) continue
      if (role === 'user') {
        if (!turnStarted || isInjectedUserContext(text)) continue
        if (pendingUser) yield pendingUser
        pendingUser = messageRecord({ payload, role, text, timestamp })
        continue
      }
      if (pendingUser) yield pendingUser
      pendingUser = null
      yield messageRecord({ payload, role, text, timestamp })
    }
  }
  if (pendingUser) yield pendingUser
}
