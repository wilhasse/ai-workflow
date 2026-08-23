import config from './config.js'
import { getPool } from './db/connection.js'
import { upsertSummary } from './db/queries.js'

// Batch summarizer: picks sessions with new messages since the last summary,
// condenses the dialog, calls an OpenAI-compatible chat endpoint, and upserts
// session_summaries. Designed to run from a timer (one pass per invocation).

const MAX_TRANSCRIPT_CHARS = 12000
const HEAD_MESSAGES = 4
const HEAD_CHARS = 3000

const SYSTEM_PROMPT = `Você resume sessões de conversa entre um engenheiro e agentes de IA (Codex/Claude Code) para permitir retomar o trabalho depois.
Escreva em português, de forma compacta e factual, com estas seções:
1. Contexto (projeto, host, ticket, repositório)
2. O que foi feito (ações confirmadas, comandos, revisões/IDs relevantes)
3. Estado atual (o que está verificado vs. pendente)
4. Próximos passos
Inclua IDs exatos (tickets, sessões, revisões SVN, hosts, caminhos) quando aparecerem. Máximo ~250 palavras.`

function clip(text, max) {
  if (!text) return ''
  const clean = text.trim()
  return clean.length > max ? `${clean.slice(0, max)} [...]` : clean
}

function buildTranscript(messages) {
  const head = messages.slice(0, HEAD_MESSAGES)
  const rest = messages.slice(HEAD_MESSAGES)
  const parts = head.map(m => `[${m.msg_role}] ${clip(m.content_text, HEAD_CHARS)}`)
  let budget = MAX_TRANSCRIPT_CHARS - parts.join('\n').length - 200
  const tail = []
  for (let i = rest.length - 1; i >= 0 && budget > 0; i--) {
    const line = `[${rest[i].msg_role}] ${clip(rest[i].content_text, 1200)}`
    if (line.length > budget) break
    tail.unshift(line)
    budget -= line.length
  }
  if (rest.length > tail.length) {
    parts.push(`[... ${rest.length - tail.length} mensagens intermediárias omitidas ...]`)
  }
  return [...parts, ...tail].join('\n\n')
}

async function callLlm(transcript) {
  // Some CPA-served reasoning models reject temperature != 1, so it is only
  // sent when explicitly configured.
  const temperature = process.env.SUMMARY_TEMPERATURE
  const res = await fetch(`${config.summary.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.summary.apiKey}`,
    },
    body: JSON.stringify({
      model: config.summary.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Resuma esta sessão:\n\n${transcript}` },
      ],
      ...(temperature ? { temperature: Number(temperature) } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM call failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM returned empty content')
  return content
}

async function candidates(limit) {
  const pool = getPool()
  const params = []
  let sourceFilter = ''
  if (config.summary.source) {
    sourceFilter = 'AND m.source = ?'
    params.push(config.summary.source)
  }
  params.push(limit)
  const [rows] = await pool.query(
    // Drive from agent_messages: agent_sessions.message_count is often 0
    // in collector data, so it cannot be trusted as the candidate filter.
    // NOTE: alias must not collide with session_summaries.msg_count —
    // MySQL resolves HAVING to the real column when names clash.
    `SELECT m.session_id, m.vm_id, COUNT(*) AS dialog_count, MAX(m.ts) AS last_ts
     FROM agent_messages m
     LEFT JOIN session_summaries sm
       ON sm.session_id = m.session_id AND sm.vm_id = m.vm_id
     WHERE m.msg_role IN ('user', 'assistant')
       AND m.content_text IS NOT NULL AND m.content_text != ''
       ${sourceFilter}
     GROUP BY m.session_id, m.vm_id, sm.msg_count
     HAVING dialog_count >= 5
       AND (sm.msg_count IS NULL OR sm.msg_count < dialog_count)
     ORDER BY last_ts DESC
     LIMIT ?`,
    params,
  )
  return rows
}

async function summarizeSession({ session_id, vm_id }) {
  const pool = getPool()
  const [messages] = await pool.query(
    `SELECT msg_role, content_text, ts FROM agent_messages
     WHERE session_id = ? AND vm_id = ?
       AND msg_role IN ('user', 'assistant')
       AND content_text IS NOT NULL AND content_text != ''
     ORDER BY seq_num ASC, ts ASC`,
    [session_id, vm_id],
  )
  if (messages.length < 2) return { skipped: true }
  const transcript = buildTranscript(messages)
  if (config.summary.dryRun) {
    return { dryRun: true, messages: messages.length, chars: transcript.length }
  }
  const summary = await callLlm(transcript)
  await upsertSummary({
    session_id,
    vm_id,
    summary,
    model: config.summary.model,
    msg_count: messages.length,
    last_message_ts: messages[messages.length - 1].ts,
  })
  return { summarized: true, messages: messages.length, chars: transcript.length }
}

async function main() {
  if (!config.summary.dryRun && !config.summary.apiKey) {
    console.error('[summarize] SUMMARY_API_KEY is empty; set it or run with SUMMARY_DRY_RUN=1')
    process.exit(1)
  }
  let ok = 0
  let failed = 0
  const failedIds = new Set()
  const maxLoops = config.summary.loops
  const workers = Math.max(1, config.summary.concurrency)
  for (let pass = 1; maxLoops === 0 || pass <= maxLoops; pass++) {
    const pending = (await candidates(config.summary.batch * workers))
      .filter(row => !failedIds.has(`${row.session_id}::${row.vm_id}`))
    if (!pending.length) {
      if (pass === 1) console.log('[summarize] 0 session(s) pending')
      break
    }
    console.log(`[summarize] pass ${pass}: ${pending.length} session(s) pending (${workers} workers)`)
    let idx = 0
    await Promise.all(Array.from({ length: workers }, async () => {
      while (idx < pending.length) {
        const row = pending[idx++]
        try {
          const result = await summarizeSession(row)
          console.log(`[summarize] ${row.session_id} (${row.vm_id}):`, JSON.stringify(result))
          if (result.summarized) ok++
        } catch (err) {
          failed++
          failedIds.add(`${row.session_id}::${row.vm_id}`)
          console.error(`[summarize] ${row.session_id} (${row.vm_id}) failed:`, err.message)
        }
      }
    }))
    if (maxLoops === 0 || pass < maxLoops) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  console.log(`[summarize] done: ${ok} summarized, ${failed} failed`)
  process.exit(failed && !ok ? 1 : 0)
}

main().catch(err => {
  console.error('[summarize] fatal:', err)
  process.exit(1)
})
