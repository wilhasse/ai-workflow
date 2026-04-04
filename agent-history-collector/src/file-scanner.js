import fs from 'node:fs/promises'
import path from 'node:path'
import config from './config.js'

async function globDir(dir, pattern, results = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await globDir(full, pattern, results)
    } else if (e.isFile() && pattern.test(e.name)) {
      results.push(full)
    }
  }
  return results
}

export async function discoverClaudeFiles() {
  const files = []

  // history.jsonl
  const histFile = path.join(config.claudeHome, 'history.jsonl')
  try {
    const st = await fs.stat(histFile)
    files.push({ path: histFile, key: 'claude:history.jsonl', size: st.size, mtime: st.mtime, type: 'claude-history' })
  } catch {}

  // projects/*/session.jsonl
  const projDir = path.join(config.claudeHome, 'projects')
  const sessionFiles = await globDir(projDir, /\.jsonl$/)
  for (const f of sessionFiles) {
    try {
      const st = await fs.stat(f)
      const rel = path.relative(config.claudeHome, f)
      files.push({ path: f, key: `claude:${rel}`, size: st.size, mtime: st.mtime, type: 'claude-session' })
    } catch {}
  }

  // sessions/*.json (metadata)
  const sessDir = path.join(config.claudeHome, 'sessions')
  const metaFiles = await globDir(sessDir, /\.json$/)
  for (const f of metaFiles) {
    try {
      const st = await fs.stat(f)
      const rel = path.relative(config.claudeHome, f)
      files.push({ path: f, key: `claude:${rel}`, size: st.size, mtime: st.mtime, type: 'claude-session-meta' })
    } catch {}
  }

  // tasks/*/n.json
  const tasksDir = path.join(config.claudeHome, 'tasks')
  const taskFiles = await globDir(tasksDir, /\.json$/)
  for (const f of taskFiles) {
    try {
      const st = await fs.stat(f)
      const rel = path.relative(config.claudeHome, f)
      files.push({ path: f, key: `claude:${rel}`, size: st.size, mtime: st.mtime, type: 'claude-tasks' })
    } catch {}
  }

  // todos/*.json
  const todosDir = path.join(config.claudeHome, 'todos')
  const todoFiles = await globDir(todosDir, /\.json$/)
  for (const f of todoFiles) {
    try {
      const st = await fs.stat(f)
      const rel = path.relative(config.claudeHome, f)
      files.push({ path: f, key: `claude:${rel}`, size: st.size, mtime: st.mtime, type: 'claude-todos' })
    } catch {}
  }

  return files
}

export async function discoverCodexFiles() {
  const files = []

  // history.jsonl
  const histFile = path.join(config.codexHome, 'history.jsonl')
  try {
    const st = await fs.stat(histFile)
    files.push({ path: histFile, key: 'codex:history.jsonl', size: st.size, mtime: st.mtime, type: 'codex-history' })
  } catch {}

  // sessions/YYYY/MM/DD/*.jsonl
  const sessDir = path.join(config.codexHome, 'sessions')
  const sessionFiles = await globDir(sessDir, /\.jsonl$/)
  for (const f of sessionFiles) {
    try {
      const st = await fs.stat(f)
      const rel = path.relative(config.codexHome, f)
      files.push({ path: f, key: `codex:${rel}`, size: st.size, mtime: st.mtime, type: 'codex-session' })
    } catch {}
  }

  return files
}
