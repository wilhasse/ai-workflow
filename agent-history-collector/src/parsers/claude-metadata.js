import fs from 'node:fs/promises'
import path from 'node:path'
import config from '../config.js'

// Parses ~/.claude/sessions/{pid}.json → session metadata
export async function* parseSessionMeta(filePath) {
  let data
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch { return }

  if (!data.sessionId) return

  yield {
    _table: 'sessions',
    session_id: data.sessionId,
    vm_id: config.vmId,
    source: 'claude',
    project: null,
    started_at: data.startedAt ?? Date.now(),
    display_text: null,
    session_meta: data,
    message_count: 0,
  }
}

// Parses ~/.claude/tasks/{session-uuid}/{n}.json → task records
export async function* parseTasks(filePath) {
  let data
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch { return }

  const sessionId = path.basename(path.dirname(filePath))
  const taskNumber = parseInt(path.basename(filePath, '.json'), 10)

  if (Array.isArray(data)) {
    for (const task of data) {
      yield {
        task_id: task.id ?? `${sessionId}-${taskNumber}-${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        vm_id: config.vmId,
        task_number: taskNumber,
        subject: task.subject ?? null,
        description: task.description ?? null,
        status: task.status ?? null,
        blocks: task.blocks ?? null,
        blocked_by: task.blockedBy ?? null,
      }
    }
  }
}

// Parses ~/.claude/todos/{uuid}.json → todo records
export async function* parseTodos(filePath) {
  let data
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch { return }

  const todoId = path.basename(filePath, '.json')

  if (Array.isArray(data) && data.length) {
    // Flatten: take first item's text for search, store full array
    const first = data[0]
    yield {
      todo_id: todoId,
      vm_id: config.vmId,
      content: first?.content ?? null,
      status: first?.status ?? null,
      priority: first?.priority ?? null,
      items_json: data,
    }
  }
}
