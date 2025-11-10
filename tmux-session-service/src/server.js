import http from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '5001', 10),
  tmuxBin: process.env.TMUX_BIN ?? 'tmux',
  defaultShell: process.env.SHELL_CMD ?? process.env.SHELL ?? '/bin/bash',
  dataDir: process.env.DATA_DIR ?? path.join(projectRoot, 'data'),
}
const storeFile = path.join(config.dataDir, 'sessions.json')
const sessionStore = new Map()

const respond = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const sanitizeId = (value) => {
  if (!value) {
    return null
  }
  const trimmed = String(value).trim()
  if (!trimmed) {
    return null
  }
  const safe = trimmed.match(/[A-Za-z0-9-_]/g)
  if (!safe) {
    return null
  }
  return safe.join('').slice(0, 64)
}

const readBody = async (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error('Invalid JSON payload'))
      }
    })
    req.on('error', reject)
  })

const ensureDataDir = async () => {
  await fs.mkdir(config.dataDir, { recursive: true })
}

const persistStore = async () => {
  await ensureDataDir()
  const data = Object.fromEntries(sessionStore.entries())
  await fs.writeFile(storeFile, JSON.stringify(data, null, 2), 'utf8')
}

const loadStore = async () => {
  try {
    const raw = await fs.readFile(storeFile, 'utf8')
    const parsed = JSON.parse(raw)
    Object.values(parsed).forEach((record) => {
      if (record && record.sessionId) {
        sessionStore.set(record.sessionId, record)
      }
    })
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to load session store:', error.message)
    }
  }
}

const runTmux = async (args) => {
  try {
    const result = await execFileAsync(config.tmuxBin, args)
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

const tmuxListSessions = async () => {
  const response = await runTmux(['list-sessions', '-F', '#S'])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return []
    }
    throw response.error
  }
  return response.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const tmuxSessionExists = async (sessionId) => {
  const response = await runTmux(['has-session', '-t', sessionId])
  if (response.ok) {
    return true
  }
  if (response.error?.code === 1) {
    return false
  }
  throw response.error
}

const tmuxCreateSession = async (sessionId, command) => {
  const shellCommand = command ?? config.defaultShell
  const args = ['new-session', '-d', '-s', sessionId, shellCommand]
  const response = await runTmux(args)
  if (!response.ok) {
    throw response.error
  }
}

const tmuxKillSession = async (sessionId) => {
  const response = await runTmux(['kill-session', '-t', sessionId])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return false
    }
    throw response.error
  }
  return true
}

const ensureMetadata = async (sessionId, { projectId = null, command = null } = {}) => {
  const now = new Date().toISOString()
  const previous = sessionStore.get(sessionId)
  const record = {
    sessionId,
    projectId: projectId ?? previous?.projectId ?? null,
    command: command ?? previous?.command ?? config.defaultShell,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  sessionStore.set(sessionId, record)
  await persistStore()
  return record
}

const ensureTmuxSession = async ({ sessionId, projectId, command }) => {
  const exists = await tmuxSessionExists(sessionId)
  if (!exists) {
    await tmuxCreateSession(sessionId, command ?? config.defaultShell)
  }
  return ensureMetadata(sessionId, { projectId, command })
}

const handleHealth = async (res) => {
  const tmuxVersion = await runTmux(['-V'])
  respond(res, 200, {
    ok: true,
    tmuxAvailable: tmuxVersion.ok,
    tmuxVersion: tmuxVersion.ok ? tmuxVersion.stdout.trim() : null,
    error: tmuxVersion.ok ? null : tmuxVersion.error?.message ?? null,
  })
}

const handleListSessions = async (res) => {
  try {
    const active = await tmuxListSessions()
    const activeSet = new Set(active)
    const payload = active.map((sessionId) => ({
      ...(sessionStore.get(sessionId) ?? { sessionId, command: config.defaultShell }),
      active: true,
    }))
    sessionStore.forEach((record, sessionId) => {
      if (!activeSet.has(sessionId)) {
        payload.push({ ...record, active: false })
      }
    })
    respond(res, 200, { sessions: payload })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleCreateSession = async (req, res) => {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }
  try {
    const sanitizedId = sanitizeId(body.sessionId) ?? sanitizeId(body.terminalId)
    const sessionId = sanitizedId ?? randomUUID().slice(0, 8)
    const projectId = sanitizeId(body.projectId)
    const command = body.command && String(body.command).trim() ? body.command : null
    const record = await ensureTmuxSession({ sessionId, projectId, command })
    respond(res, 201, { session: record })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleEnsureSession = async (req, res, sessionId) => {
  const sanitizedId = sanitizeId(sessionId)
  if (!sanitizedId) {
    respond(res, 400, { error: 'Invalid session id' })
    return
  }
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }
  try {
    const projectId = sanitizeId(body.projectId)
    const command = body.command && String(body.command).trim() ? body.command : null
    const record = await ensureTmuxSession({ sessionId: sanitizedId, projectId, command })
    respond(res, 200, { session: record })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleDeleteSession = async (res, sessionId) => {
  const sanitizedId = sanitizeId(sessionId)
  if (!sanitizedId) {
    respond(res, 400, { error: 'Invalid session id' })
    return
  }
  try {
    const removed = await tmuxKillSession(sanitizedId)
    if (!removed) {
      respond(res, 404, { error: 'Session not found' })
      return
    }
    sessionStore.delete(sanitizedId)
    await persistStore()
    respond(res, 204, {})
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleKeepAlive = async (res, sessionId) => {
  const sanitizedId = sanitizeId(sessionId)
  if (!sanitizedId) {
    respond(res, 400, { error: 'Invalid session id' })
    return
  }
  try {
    const record = await ensureMetadata(sanitizedId, {})
    respond(res, 200, { session: record })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const notFound = (res) => respond(res, 404, { error: 'Not found' })

const server = http.createServer(async (req, res) => {
  const { method, url } = req
  const parsed = new URL(url, `http://${req.headers.host}`)
  const pathName = parsed.pathname

  if (method === 'GET' && pathName === '/health') {
    await handleHealth(res)
    return
  }
  if (method === 'GET' && pathName === '/sessions') {
    await handleListSessions(res)
    return
  }
  if (method === 'POST' && pathName === '/sessions') {
    await handleCreateSession(req, res)
    return
  }
  const sessionMatch = pathName.match(/^\/sessions\/([^/]+)$/)
  if (sessionMatch && method === 'PUT') {
    await handleEnsureSession(req, res, sessionMatch[1])
    return
  }
  if (sessionMatch && method === 'DELETE') {
    await handleDeleteSession(res, sessionMatch[1])
    return
  }
  const keepAliveMatch = pathName.match(/^\/sessions\/([^/]+)\/keepalive$/)
  if (keepAliveMatch && method === 'POST') {
    await handleKeepAlive(res, keepAliveMatch[1])
    return
  }
  notFound(res)
})

const start = async () => {
  await ensureDataDir()
  await loadStore()
  server.listen(config.port, config.host, () => {
    console.log(`tmux-session-service listening on http://${config.host}:${config.port}`)
  })
}

start().catch((error) => {
  console.error('Unable to start tmux-session-service:', error)
  process.exit(1)
})
