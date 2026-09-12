import * as queries from '../db/queries.js'

const MAX_MSG_CHARS = 1500

function clip(text) {
  if (!text) return ''
  const clean = text.trim()
  if (clean.length <= MAX_MSG_CHARS) return clean
  return `${clean.slice(0, MAX_MSG_CHARS)}\n[... truncated ${clean.length - MAX_MSG_CHARS} chars]`
}

export function renderHandoff({ session, summary, messages }) {
  const lines = []
  const title = session?.display_text?.split('\n')[0]?.slice(0, 120) || session?.session_id || 'unknown'
  lines.push(`# Conversation handoff: ${title}`)
  lines.push('')
  if (session) {
    lines.push(`- session_id: \`${session.session_id}\``)
    lines.push(`- vm_id: \`${session.vm_id}\` | source: \`${session.source}\` | started: ${session.started_at}`)
    if (session.project) lines.push(`- project: \`${session.project}\``)
    lines.push('')
  }
  if (summary?.summary) {
    lines.push(`## Summary (model: ${summary.model}, covers ${summary.msg_count} messages, updated ${summary.updated_at})`)
    lines.push('')
    lines.push(summary.summary.trim())
    lines.push('')
  } else {
    lines.push('## Summary')
    lines.push('')
    lines.push('_No LLM summary stored for this session yet._')
    lines.push('')
  }
  lines.push(`## Recent messages (${messages.length})`)
  lines.push('')
  for (const m of messages) {
    const role = m.msg_role || m.msg_type || 'unknown'
    lines.push(`### [${m.ts}] ${role}`)
    lines.push('')
    lines.push(clip(m.content_text) || '_(no text content)_')
    lines.push('')
  }
  return lines.join('\n')
}

export async function buildHandoff(sessionId, { vm_id, tail = 40 } = {}) {
  const host = await queries.resolveSessionHost(sessionId, vm_id)
  if (!host) return null
  const scope = { vm_id: host }
  const session = await queries.getSession(sessionId, scope)
  const summary = await queries.getSummary(sessionId, scope)
  const messages = await queries.getSessionMessages(sessionId, {
    ...scope, limit: Math.min(200, Math.max(1, Number(tail))), dialog: true, recent: true,
  })
  const first = session ? null : (await queries.getSessionMessages(sessionId, { ...scope, limit: 1 }))[0]
  if (!session && !first) return null
  const effectiveSession = session ?? {
    session_id: sessionId,
    vm_id: host,
    source: first.source,
    started_at: first.ts,
    project: null,
    display_text: null,
  }
  return renderHandoff({ session: effectiveSession, summary, messages })
}
