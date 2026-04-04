import * as queries from '../db/queries.js'

const HANDLERS = {
  sessions: queries.upsertSessions,
  messages: queries.upsertMessages,
  history: queries.upsertHistory,
  tasks: queries.upsertTasks,
  todos: queries.upsertTodos,
  'sync-state': queries.upsertSyncState,
}

const MAX_BATCH = 500

export async function handleIngest(entity, body) {
  const handler = HANDLERS[entity]
  if (!handler) return { status: 404, body: { ok: false, error: `Unknown entity: ${entity}` } }

  const records = body.records
  if (!Array.isArray(records) || !records.length) {
    return { status: 400, body: { ok: false, error: 'records array required' } }
  }

  let inserted = 0
  for (let i = 0; i < records.length; i += MAX_BATCH) {
    const batch = records.slice(i, i + MAX_BATCH)
    await handler(batch)
    inserted += batch.length
  }

  return { status: 200, body: { ok: true, inserted } }
}
