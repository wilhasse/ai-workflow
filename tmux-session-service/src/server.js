import http from 'node:http'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { randomUUID, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import pty from 'node-pty'
import { WebSocketServer, WebSocket } from 'ws'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '5001', 10),
  tmuxBin: process.env.TMUX_BIN ?? 'tmux',
  defaultShell: process.env.SHELL_CMD ?? process.env.SHELL ?? '/bin/bash',
  dataDir: process.env.DATA_DIR ?? path.join(projectRoot, 'data'),
  workspacesConfig: process.env.WORKSPACES_CONFIG ?? path.join(os.homedir(), 'ai-workflow', 'workspace-switcher', 'workspaces.json'),
  mobileWorkspacesConfig: process.env.MOBILE_WORKSPACES_CONFIG ?? path.join(os.homedir(), 'ai-workflow', 'workspace-v2', 'catalog', 'workspaces.v2.json'),
  mobileSelfHostId: process.env.MOBILE_SELF_HOST_ID ?? process.env.WSV2_SELF_HOST ?? 'vm10',
}
const storeFile = path.join(config.dataDir, 'sessions.json')
const userStoreFile = path.join(config.dataDir, 'users.json')
const sessionStore = new Map()
const userStoreById = new Map()
const userStoreByUsername = new Map()
const authTokens = new Map()
const scryptAsync = promisify(scrypt)

const defaultHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
}

const respond = (res, status, payload) => {
  res.writeHead(status, defaultHeaders)
  if (status === 204) {
    res.end()
    return
  }
  res.end(JSON.stringify(payload ?? {}))
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

const sanitizeUsername = (value) => {
  if (!value) {
    return null
  }
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed) {
    return null
  }
  const safe = trimmed.match(/[a-z0-9._-]/g)
  if (!safe) {
    return null
  }
  return safe.join('').slice(0, 64)
}

const defaultProjectsForUser = () => [
  {
    id: 'shell-workspace',
    name: 'Shell Workspace',
    description: '',
    protocol: 'http',
    baseHost: '10.1.0.10',
    basePort: 5001,
    portStrategy: 'single',
    portStrategyLocked: true,
    terminals: [],
  },
]

const serializeUser = (user) => ({
  id: user.id,
  username: user.username,
  projects: Array.isArray(user.projects) ? user.projects : [],
})

const formatDiscoveredWorkspaceName = (sessionId) =>
  String(sessionId)
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || String(sessionId)

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

const normalizePath = (value) => {
  if (!value) {
    return ''
  }
  return String(value).replace(/^~(?=$|\/)/, os.homedir()).replace(/\/+$/, '') || '/'
}

const isHostLocal = (host) => host?.id === config.mobileSelfHostId || host?.id === 'local'

const safeErrorMessage = (error) => error?.message ?? String(error)

const persistUsers = async () => {
  await ensureDataDir()
  const payload = {}
  userStoreById.forEach((user) => {
    payload[user.id] = {
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      projects: Array.isArray(user.projects) ? user.projects : [],
    }
  })
  await fs.writeFile(userStoreFile, JSON.stringify(payload, null, 2), 'utf8')
}

const loadUsers = async () => {
  try {
    const raw = await fs.readFile(userStoreFile, 'utf8')
    const parsed = JSON.parse(raw)
    Object.values(parsed).forEach((record) => {
      if (record?.id && record?.username && record?.passwordHash) {
        const normalized = {
          id: record.id,
          username: record.username,
          passwordHash: record.passwordHash,
          projects: Array.isArray(record.projects) ? record.projects : [],
        }
        userStoreById.set(normalized.id, normalized)
        userStoreByUsername.set(normalized.username.toLowerCase(), normalized)
      }
    })
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to load user store:', error.message)
    }
  }
}

const hashPassword = async (password) => {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, 64)
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

const verifyPassword = async (password, storedHash) => {
  if (!storedHash) {
    return false
  }
  const [saltHex, hashHex] = storedHash.split(':')
  if (!saltHex || !hashHex) {
    return false
  }
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64)
  const existing = Buffer.from(hashHex, 'hex')
  if (derived.length !== existing.length) {
    return false
  }
  try {
    return timingSafeEqual(derived, existing)
  } catch {
    return false
  }
}

const createUserRecord = async (username, password) => {
  const user = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    projects: defaultProjectsForUser(),
  }
  userStoreById.set(user.id, user)
  userStoreByUsername.set(username.toLowerCase(), user)
  await persistUsers()
  return user
}

const issueToken = (userId) => {
  const token = randomUUID()
  authTokens.set(token, userId)
  return token
}

const authenticateRequest = (req) => {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string') {
    return null
  }
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return null
  }
  const token = match[1].trim()
  if (!token) {
    return null
  }
  const userId = authTokens.get(token)
  if (!userId) {
    return null
  }
  return userStoreById.get(userId) ?? null
}

const updateUserProjects = async (user, projects) => {
  const normalizedProjects = Array.isArray(projects) ? projects : []
  user.projects = normalizedProjects
  userStoreById.set(user.id, user)
  userStoreByUsername.set(user.username.toLowerCase(), user)
  await persistUsers()
  return user.projects
}

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

/**
 * Discovers tmux sessions that exist but are not yet in the metadata store.
 * This allows SSH-created sessions to appear in the web dashboard.
 */
const discoverTmuxSessions = async () => {
  try {
    const activeSessions = await tmuxListSessions()
    let discovered = 0
    for (const sessionId of activeSessions) {
      if (!sessionStore.has(sessionId)) {
        const now = new Date().toISOString()
        const record = {
          sessionId,
          projectId: null,
          command: config.defaultShell,
          source: 'discovered',
          createdAt: now,
          updatedAt: now,
        }
        sessionStore.set(sessionId, record)
        discovered++
      }
    }
    if (discovered > 0) {
      await persistStore()
      console.log(`[discovery] Found ${discovered} new tmux session(s)`)
    }
  } catch (error) {
    console.warn('[discovery] Session discovery failed:', error.message)
  }
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

const tmuxListWindows = async (sessionId) => {
  const response = await runTmux([
    'list-windows',
    '-t', sessionId,
    '-F', '#{window_index}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}',
  ])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return []
    }
    throw response.error
  }
  return response.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, name, active, activity, panes] = line.split('|')
      const activitySeconds = Number.parseInt(activity, 10)
      const paneCount = Number.parseInt(panes, 10)
      return {
        index: Number.parseInt(index, 10),
        name: name || `window-${index}`,
        active: active === '1',
        lastActivityAt: Number.isFinite(activitySeconds) ? activitySeconds * 1000 : 0,
        paneCount: Number.isFinite(paneCount) ? paneCount : 0,
      }
    })
}

const parseTmuxWindowRows = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sessionId, index, name, active, activity, panes] = line.split('|')
      const windowIndex = Number.parseInt(index, 10)
      const activitySeconds = Number.parseInt(activity, 10)
      const paneCount = Number.parseInt(panes, 10)
      if (!sessionId || !Number.isFinite(windowIndex)) {
        return null
      }
      return {
        sessionId,
        index: windowIndex,
        name: name || `window-${index}`,
        active: active === '1',
        lastActivityAt: Number.isFinite(activitySeconds) ? activitySeconds * 1000 : 0,
        paneCount: Number.isFinite(paneCount) ? paneCount : 0,
      }
    })
    .filter(Boolean)

const groupWindowsBySession = (windows) => {
  const grouped = new Map()
  windows.forEach((window) => {
    if (!grouped.has(window.sessionId)) {
      grouped.set(window.sessionId, [])
    }
    grouped.get(window.sessionId).push({
      index: window.index,
      name: window.name,
      active: window.active,
      lastActivityAt: window.lastActivityAt,
      paneCount: window.paneCount,
    })
  })
  grouped.forEach((items) => {
    items.sort((left, right) => left.index - right.index)
  })
  return grouped
}

const tmuxListAllWindows = async () => {
  const response = await runTmux([
    'list-windows',
    '-a',
    '-F',
    '#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}',
  ])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return []
    }
    throw response.error
  }
  return parseTmuxWindowRows(response.stdout)
}

const runSsh = async (sshTarget, remoteCommand, timeout = 8000) => {
  try {
    const result = await execFileAsync(
      'ssh',
      [
        '-o',
        'ConnectTimeout=3',
        '-o',
        'BatchMode=yes',
        sshTarget,
        remoteCommand,
      ],
      { timeout, maxBuffer: 1024 * 1024 },
    )
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

const remoteListAllWindows = async (host) => {
  if (!host?.ssh) {
    throw new Error('Host has no SSH target')
  }
  const response = await runSsh(
    host.ssh,
    `${config.tmuxBin} list-windows -a -F ${shellQuote('#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}')} 2>/dev/null || true`,
  )
  if (!response.ok) {
    throw response.error
  }
  return parseTmuxWindowRows(response.stdout)
}

const tmuxSelectWindow = async (sessionId, windowIndex) => {
  const response = await runTmux(['select-window', '-t', `${sessionId}:${windowIndex}`])
  return response.ok
}

const sanitizeWindowName = (value) => {
  if (!value) {
    return null
  }
  const normalized = String(value).replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }
  return normalized.slice(0, 80)
}

const tmuxRenameWindow = async (sessionId, windowIndex, windowName) => {
  const response = await runTmux(['rename-window', '-t', `${sessionId}:${windowIndex}`, windowName])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return false
    }
    throw response.error
  }
  return true
}

const tmuxGetWindowSize = async (sessionId, windowIndex = null) => {
  const target =
    windowIndex !== null && Number.isFinite(windowIndex)
      ? `${sessionId}:${windowIndex}`
      : sessionId
  const response = await runTmux([
    'display-message',
    '-p',
    '-t',
    target,
    '#{window_width}|#{window_height}',
  ])
  if (!response.ok) {
    return null
  }
  const [colsRaw, rowsRaw] = response.stdout.trim().split('|')
  const cols = Number.parseInt(colsRaw, 10)
  const rows = Number.parseInt(rowsRaw, 10)
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null
  }
  return { cols, rows }
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

const loadMobileCatalog = async () => {
  const raw = await fs.readFile(config.mobileWorkspacesConfig, 'utf8')
  const payload = JSON.parse(raw)
  const hosts = Array.isArray(payload.hosts)
    ? payload.hosts
        .map((host) => ({
          id: sanitizeId(host.id) ?? 'local',
          name: String(host.name || host.id || 'Local'),
          ssh: host.ssh ? String(host.ssh) : null,
          hostnames: Array.isArray(host.hostnames) ? host.hostnames : [],
          legacyIds: Array.isArray(host.legacy_ids) ? host.legacy_ids : [],
        }))
        .filter((host) => host.id)
    : [{ id: 'local', name: 'Local', ssh: null, hostnames: [], legacyIds: [] }]
  const hostLookup = new Map(hosts.map((host) => [host.id, host]))
  const workspaces = Array.isArray(payload.workspaces)
    ? payload.workspaces
        .map((workspace) => {
          const hostId = sanitizeId(workspace.host) ?? config.mobileSelfHostId ?? 'local'
          const host = hostLookup.get(hostId) ?? hostLookup.get('local') ?? hosts[0]
          const id = sanitizeId(workspace.id)
          if (!id || !host) {
            return null
          }
          return {
            id,
            name: String(workspace.name || workspace.id),
            description: String(workspace.description || ''),
            path: normalizePath(workspace.path || ''),
            color: String(workspace.color || '#3498db'),
            icon: String(workspace.icon || 'folder'),
            hostId: host.id,
            source: 'configured',
          }
        })
        .filter(Boolean)
    : []

  return { hosts, workspaces }
}

const decorateMobileWorkspace = ({ workspace, host, windows, active }) => {
  const lastActivityAt = windows.reduce(
    (latest, window) => Math.max(latest, window.lastActivityAt || 0),
    0,
  )
  return {
    ...workspace,
    key: `${host.id}:${workspace.id}`,
    hostId: host.id,
    hostName: host.name,
    local: isHostLocal(host),
    active,
    reachable: true,
    windows,
    windowCount: windows.length,
    lastActivityAt,
    connection: {
      type: isHostLocal(host) ? 'local' : 'remote',
      hostId: host.id,
      sessionId: workspace.id,
    },
  }
}

const buildHostMobileInventory = async (host, configuredWorkspaces) => {
  const windowRows = isHostLocal(host)
    ? await tmuxListAllWindows()
    : await remoteListAllWindows(host)
  const windowsBySession = groupWindowsBySession(windowRows)
  const activeSessionIds = new Set(windowsBySession.keys())
  const configuredIds = new Set(configuredWorkspaces.map((workspace) => workspace.id))
  const workspaces = configuredWorkspaces.map((workspace) =>
    decorateMobileWorkspace({
      workspace,
      host,
      windows: windowsBySession.get(workspace.id) ?? [],
      active: activeSessionIds.has(workspace.id),
    }),
  )

  activeSessionIds.forEach((sessionId) => {
    if (configuredIds.has(sessionId)) {
      return
    }
    workspaces.push(
      decorateMobileWorkspace({
        workspace: {
          id: sessionId,
          name: formatDiscoveredWorkspaceName(sessionId),
          description: 'Discovered tmux session',
          path: '',
          color: '#64748b',
          icon: 'terminal',
          hostId: host.id,
          source: 'discovered',
          discovered: true,
        },
        host,
        windows: windowsBySession.get(sessionId) ?? [],
        active: true,
      }),
    )
  })

  workspaces.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1
    }
    if (right.lastActivityAt !== left.lastActivityAt) {
      return right.lastActivityAt - left.lastActivityAt
    }
    return left.name.localeCompare(right.name)
  })

  return {
    id: host.id,
    name: host.name,
    local: isHostLocal(host),
    reachable: true,
    workspaceCount: workspaces.length,
    activeWorkspaceCount: workspaces.filter((workspace) => workspace.active).length,
    workspaces,
  }
}

const handleMobileWorkspaces = async (res) => {
  try {
    const catalog = await loadMobileCatalog()
    const workspacesByHost = new Map()
    catalog.hosts.forEach((host) => workspacesByHost.set(host.id, []))
    catalog.workspaces.forEach((workspace) => {
      if (!workspacesByHost.has(workspace.hostId)) {
        workspacesByHost.set(workspace.hostId, [])
      }
      workspacesByHost.get(workspace.hostId).push(workspace)
    })

    const hosts = []
    for (const host of catalog.hosts) {
      try {
        hosts.push(await buildHostMobileInventory(host, workspacesByHost.get(host.id) ?? []))
      } catch (error) {
        hosts.push({
          id: host.id,
          name: host.name,
          local: isHostLocal(host),
          reachable: false,
          error: safeErrorMessage(error),
          workspaceCount: (workspacesByHost.get(host.id) ?? []).length,
          activeWorkspaceCount: 0,
          workspaces: (workspacesByHost.get(host.id) ?? []).map((workspace) => ({
            ...workspace,
            key: `${host.id}:${workspace.id}`,
            hostName: host.name,
            local: isHostLocal(host),
            active: false,
            reachable: false,
            windows: [],
            windowCount: 0,
            lastActivityAt: 0,
            connection: {
              type: isHostLocal(host) ? 'local' : 'remote',
              hostId: host.id,
              sessionId: workspace.id,
            },
          })),
        })
      }
    }

    const flatWorkspaces = hosts.flatMap((host) => host.workspaces)
    respond(res, 200, {
      selfHostId: config.mobileSelfHostId,
      scannedAt: new Date().toISOString(),
      hosts,
      workspaces: flatWorkspaces,
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error), hosts: [], workspaces: [] })
  }
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

const handleRegister = async (req, res) => {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }
  const username = sanitizeUsername(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!username || password.length < 6) {
    respond(res, 400, { error: 'Username and password are required (min 6 chars).' })
    return
  }
  if (userStoreByUsername.has(username)) {
    respond(res, 409, { error: 'User already exists.' })
    return
  }
  try {
    const user = await createUserRecord(username, password)
    const token = issueToken(user.id)
    respond(res, 201, { token, user: serializeUser(user) })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleLogin = async (req, res) => {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }
  const username = sanitizeUsername(body.username)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!username || !password) {
    respond(res, 400, { error: 'Missing username or password.' })
    return
  }
  const user = userStoreByUsername.get(username)
  if (!user) {
    respond(res, 401, { error: 'Invalid username or password.' })
    return
  }
  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) {
    respond(res, 401, { error: 'Invalid username or password.' })
    return
  }
  const token = issueToken(user.id)
  respond(res, 200, { token, user: serializeUser(user) })
}

const requireUser = (req, res) => {
  const user = authenticateRequest(req)
  if (!user) {
    respond(res, 401, { error: 'Unauthorized' })
    return null
  }
  return user
}

const handleGetMe = (req, res) => {
  const user = requireUser(req, res)
  if (!user) {
    return
  }
  respond(res, 200, { user: serializeUser(user) })
}

const handleGetProjects = (req, res) => {
  const user = requireUser(req, res)
  if (!user) {
    return
  }
  respond(res, 200, { projects: Array.isArray(user.projects) ? user.projects : [] })
}

const handleSaveProjects = async (req, res) => {
  const user = requireUser(req, res)
  if (!user) {
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
    const projects = await updateUserProjects(user, body.projects)
    respond(res, 200, { projects })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleGetWorkspaces = async (res) => {
  try {
    const raw = await fs.readFile(config.workspacesConfig, 'utf8')
    const workspacesData = JSON.parse(raw)

    // Enrich with session status
    const activeSessions = await tmuxListSessions()
    const activeSet = new Set(activeSessions)

    const configuredWorkspaces = workspacesData.workspaces || []
    const configuredIds = new Set(configuredWorkspaces.map((workspace) => workspace.id))
    const workspaces = configuredWorkspaces.map((ws) => ({
      ...ws,
      active: activeSet.has(ws.id),
    }))

    activeSessions.forEach((sessionId) => {
      if (configuredIds.has(sessionId)) {
        return
      }
      workspaces.push({
        id: sessionId,
        name: formatDiscoveredWorkspaceName(sessionId),
        description: 'Discovered tmux session',
        active: true,
        discovered: true,
      })
    })

    respond(res, 200, { workspaces, settings: workspacesData.settings || {} })
  } catch (error) {
    if (error.code === 'ENOENT') {
      respond(res, 200, { workspaces: [], settings: {} })
    } else {
      respond(res, 500, { error: error.message })
    }
  }
}

const handleListWindows = async (res, sessionId) => {
  const sanitizedId = sanitizeId(sessionId)
  if (!sanitizedId) {
    respond(res, 400, { error: 'Invalid session id' })
    return
  }
  try {
    const exists = await tmuxSessionExists(sanitizedId)
    if (!exists) {
      respond(res, 404, { error: 'Session not found', windows: [] })
      return
    }
    const windows = await tmuxListWindows(sanitizedId)
    respond(res, 200, { sessionId: sanitizedId, windows })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const handleRenameWindow = async (req, res, sessionId, windowIndexRaw) => {
  const sanitizedId = sanitizeId(sessionId)
  const windowIndex = Number.parseInt(windowIndexRaw, 10)
  if (!sanitizedId || !Number.isFinite(windowIndex)) {
    respond(res, 400, { error: 'Invalid session or window index' })
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }

  const windowName = sanitizeWindowName(body.name)
  if (!windowName) {
    respond(res, 400, { error: 'Window name is required' })
    return
  }

  try {
    const renamed = await tmuxRenameWindow(sanitizedId, windowIndex, windowName)
    if (!renamed) {
      respond(res, 404, { error: 'Window not found' })
      return
    }
    const windows = await tmuxListWindows(sanitizedId)
    respond(res, 200, { sessionId: sanitizedId, windows })
  } catch (error) {
    respond(res, 500, { error: error.message })
  }
}

const notFound = (res) => respond(res, 404, { error: 'Not found' })

const server = http.createServer(async (req, res) => {
  const { method, url } = req
  const parsed = new URL(url, `http://${req.headers.host}`)
  const pathName = parsed.pathname

  if (method === 'OPTIONS') {
    respond(res, 204, {})
    return
  }

  if (method === 'POST' && pathName === '/auth/register') {
    await handleRegister(req, res)
    return
  }

  if (method === 'POST' && pathName === '/auth/login') {
    await handleLogin(req, res)
    return
  }

  if (method === 'GET' && pathName === '/me') {
    handleGetMe(req, res)
    return
  }

  if (method === 'GET' && pathName === '/me/projects') {
    handleGetProjects(req, res)
    return
  }

  if (method === 'PUT' && pathName === '/me/projects') {
    await handleSaveProjects(req, res)
    return
  }

  if (method === 'GET' && pathName === '/health') {
    await handleHealth(res)
    return
  }
  if (method === 'GET' && pathName === '/workspaces') {
    await handleGetWorkspaces(res)
    return
  }
  if (method === 'GET' && pathName === '/mobile/workspaces') {
    await handleMobileWorkspaces(res)
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
  const windowsMatch = pathName.match(/^\/sessions\/([^/]+)\/windows$/)
  if (windowsMatch && method === 'GET') {
    await handleListWindows(res, windowsMatch[1])
    return
  }
  const renameWindowMatch = pathName.match(/^\/sessions\/([^/]+)\/windows\/([^/]+)$/)
  if (renameWindowMatch && method === 'PUT') {
    await handleRenameWindow(req, res, renameWindowMatch[1], renameWindowMatch[2])
    return
  }
  const keepAliveMatch = pathName.match(/^\/sessions\/([^/]+)\/keepalive$/)
  if (keepAliveMatch && method === 'POST') {
    await handleKeepAlive(res, keepAliveMatch[1])
    return
  }
  notFound(res)
})

const wss = new WebSocketServer({ noServer: true })

const sendWsMessage = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

const parseTerminalSocketOptions = (searchParams) => {
  const windowIndexRaw = searchParams.get('windowIndex')
  const initialColsRaw = searchParams.get('cols')
  const initialRowsRaw = searchParams.get('rows')
  const monitorFlag = (searchParams.get('monitor') ?? '').toLowerCase()
  return {
    windowIndex: windowIndexRaw !== null ? Number.parseInt(windowIndexRaw, 10) : null,
    initialCols: initialColsRaw !== null ? Number.parseInt(initialColsRaw, 10) : null,
    initialRows: initialRowsRaw !== null ? Number.parseInt(initialRowsRaw, 10) : null,
    monitorMode: monitorFlag === '1' || monitorFlag === 'true',
  }
}

const handleTerminalSocket = async (ws, sessionIdRaw, searchParams) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const sanitizedProjectId = sanitizeId(searchParams.get('projectId'))
  const { windowIndex, initialCols, initialRows, monitorMode } = parseTerminalSocketOptions(searchParams)

  if (!sanitizedSessionId) {
    sendWsMessage(ws, { type: 'error', message: 'Invalid session id' })
    ws.close(1008, 'Invalid session id')
    return
  }

  try {
    await ensureTmuxSession({ sessionId: sanitizedSessionId, projectId: sanitizedProjectId })
  } catch (error) {
    console.warn('Unable to ensure tmux session', error)
    sendWsMessage(ws, { type: 'error', message: 'Unable to prepare tmux session' })
    ws.close(1011, 'Session unavailable')
    return
  }

  // Select specific window if requested
  if (windowIndex !== null && Number.isFinite(windowIndex)) {
    try {
      await tmuxSelectWindow(sanitizedSessionId, windowIndex)
    } catch (error) {
      console.warn('Failed to select window', error.message)
      // Continue anyway - will attach to current window
    }
  }

  let initialSize = null
  if (monitorMode) {
    try {
      initialSize = await tmuxGetWindowSize(sanitizedSessionId, windowIndex)
    } catch (error) {
      console.warn('Failed to read tmux window size', error.message)
    }
  }

  const ptyCols =
    !monitorMode && Number.isFinite(initialCols) && initialCols > 0
      ? initialCols
      : initialSize?.cols ?? 80
  const ptyRows =
    !monitorMode && Number.isFinite(initialRows) && initialRows > 0
      ? initialRows
      : initialSize?.rows ?? 24

  let ptyProcess
  try {
    ptyProcess = pty.spawn(
      config.tmuxBin,
      ['attach-session', '-t', sanitizedSessionId],
      {
        name: 'xterm-256color',
        cols: ptyCols,
        rows: ptyRows,
        cwd: process.env.HOME ?? process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      },
    )
  } catch (error) {
    console.warn('Failed to start tmux pty', error)
    sendWsMessage(ws, { type: 'error', message: 'Unable to attach tmux session' })
    ws.close(1011, 'Failed to attach tmux session')
    return
  }

  const cleanup = () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill()
      } catch (error) {
        console.warn('Failed to clean up pty', error.message)
      }
      ptyProcess = null
    }
  }

  ptyProcess.onData((data) => {
    sendWsMessage(ws, { type: 'data', payload: data })
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    sendWsMessage(ws, { type: 'exit', exitCode, signal })
    ws.close(1000, 'tmux session detached')
    cleanup()
  })

  ws.on('message', (raw) => {
    let incoming
    try {
      incoming = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (incoming.type === 'input' && typeof incoming.payload === 'string') {
      if (monitorMode) {
        return
      }
      ptyProcess?.write(incoming.payload)
      return
    }
    if (incoming.type === 'resize') {
      if (monitorMode) {
        return
      }
      const cols = Number.parseInt(incoming.cols, 10)
      const rows = Number.parseInt(incoming.rows, 10)
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        try {
          ptyProcess?.resize(cols, rows)
        } catch (error) {
          console.warn('Failed to resize pty', error.message)
        }
      }
    }
  })

  ws.on('close', cleanup)
  ws.on('error', (error) => {
    console.warn('WebSocket error for session', sanitizedSessionId, error.message)
    cleanup()
  })

  // Ping/pong keepalive to prevent timeout
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, 30000) // Ping every 30 seconds

  ws.on('close', () => clearInterval(pingInterval))

  sendWsMessage(ws, {
    type: 'ready',
    sessionId: sanitizedSessionId,
    cols: ptyCols,
    rows: ptyRows,
    monitor: monitorMode,
  })
}

const findMobileHost = async (hostId) => {
  const sanitizedHostId = sanitizeId(hostId)
  if (!sanitizedHostId) {
    return null
  }
  const catalog = await loadMobileCatalog()
  return catalog.hosts.find((host) => host.id === sanitizedHostId) ?? null
}

const buildRemoteAttachCommand = ({ sessionId, windowIndex }) => {
  const sessionTarget = shellQuote(sessionId)
  const commands = [
    `${config.tmuxBin} has-session -t ${sessionTarget} 2>/dev/null || ${config.tmuxBin} new-session -d -s ${sessionTarget}`,
  ]
  if (windowIndex !== null && Number.isFinite(windowIndex)) {
    commands.push(`${config.tmuxBin} select-window -t ${shellQuote(`${sessionId}:${windowIndex}`)} 2>/dev/null || true`)
  }
  commands.push(`exec ${config.tmuxBin} attach-session -t ${sessionTarget}`)
  return commands.join('; ')
}

const handleRemoteTerminalSocket = async (ws, hostIdRaw, sessionIdRaw, searchParams) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const host = await findMobileHost(hostIdRaw)
  const { windowIndex, initialCols, initialRows, monitorMode } = parseTerminalSocketOptions(searchParams)

  if (!host || isHostLocal(host) || !host.ssh) {
    sendWsMessage(ws, { type: 'error', message: 'Invalid remote host' })
    ws.close(1008, 'Invalid remote host')
    return
  }
  if (!sanitizedSessionId) {
    sendWsMessage(ws, { type: 'error', message: 'Invalid session id' })
    ws.close(1008, 'Invalid session id')
    return
  }

  const ptyCols = !monitorMode && Number.isFinite(initialCols) && initialCols > 0 ? initialCols : 80
  const ptyRows = !monitorMode && Number.isFinite(initialRows) && initialRows > 0 ? initialRows : 24
  let ptyProcess

  try {
    ptyProcess = pty.spawn(
      'ssh',
      [
        '-tt',
        '-o',
        'ServerAliveInterval=60',
        '-o',
        'ServerAliveCountMax=3',
        host.ssh,
        buildRemoteAttachCommand({ sessionId: sanitizedSessionId, windowIndex }),
      ],
      {
        name: 'xterm-256color',
        cols: ptyCols,
        rows: ptyRows,
        cwd: process.env.HOME ?? process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      },
    )
  } catch (error) {
    console.warn('Failed to start remote tmux pty', error)
    sendWsMessage(ws, { type: 'error', message: 'Unable to attach remote tmux session' })
    ws.close(1011, 'Failed to attach remote tmux session')
    return
  }

  const cleanup = () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill()
      } catch (error) {
        console.warn('Failed to clean up remote pty', error.message)
      }
      ptyProcess = null
    }
  }

  ptyProcess.onData((data) => {
    sendWsMessage(ws, { type: 'data', payload: data })
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    sendWsMessage(ws, { type: 'exit', exitCode, signal })
    ws.close(1000, 'remote tmux session detached')
    cleanup()
  })

  ws.on('message', (raw) => {
    let incoming
    try {
      incoming = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (incoming.type === 'input' && typeof incoming.payload === 'string') {
      if (!monitorMode) {
        ptyProcess?.write(incoming.payload)
      }
      return
    }
    if (incoming.type === 'resize') {
      if (monitorMode) {
        return
      }
      const cols = Number.parseInt(incoming.cols, 10)
      const rows = Number.parseInt(incoming.rows, 10)
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        try {
          ptyProcess?.resize(cols, rows)
        } catch (error) {
          console.warn('Failed to resize remote pty', error.message)
        }
      }
    }
  })

  ws.on('close', cleanup)
  ws.on('error', (error) => {
    console.warn('Remote WebSocket error for session', sanitizedSessionId, error.message)
    cleanup()
  })

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, 30000)

  ws.on('close', () => clearInterval(pingInterval))

  sendWsMessage(ws, {
    type: 'ready',
    sessionId: sanitizedSessionId,
    hostId: host.id,
    cols: ptyCols,
    rows: ptyRows,
    monitor: monitorMode,
  })
}

server.on('upgrade', (req, socket, head) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`)
    const localMatch = parsed.pathname.match(/^\/ws\/sessions\/([^/]+)$/)
    const remoteMatch = parsed.pathname.match(/^\/ws\/remote-sessions\/([^/]+)\/([^/]+)$/)
    if (!localMatch && !remoteMatch) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handler = localMatch
        ? handleTerminalSocket(ws, localMatch[1], parsed.searchParams)
        : handleRemoteTerminalSocket(ws, remoteMatch[1], remoteMatch[2], parsed.searchParams)
      handler.catch((error) => {
        console.error('Terminal socket error', error)
        ws.close(1011, 'Internal server error')
      })
    })
  } catch (error) {
    console.warn('Failed to handle websocket upgrade', error)
    socket.destroy()
  }
})

const start = async () => {
  await ensureDataDir()
  await loadUsers()
  await loadStore()

  // Discover any existing tmux sessions not in metadata
  await discoverTmuxSessions()

  server.listen(config.port, config.host, () => {
    console.log(`tmux-session-service listening on http://${config.host}:${config.port}`)

    // Periodic session discovery (every 60 seconds)
    setInterval(discoverTmuxSessions, 60000)
  })
}

start().catch((error) => {
  console.error('Unable to start tmux-session-service:', error)
  process.exit(1)
})
