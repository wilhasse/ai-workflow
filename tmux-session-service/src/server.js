import http from 'node:http'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
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
  launcherStatePath: process.env.WSV2_STATE_PATH ?? path.join(os.homedir(), '.local', 'state', 'ai-workflow', 'workspace-v2.json'),
  sessionArchivePath: process.env.WSV2_SESSION_ARCHIVE_PATH ?? path.join(os.homedir(), '.local', 'state', 'ai-workflow', 'workspace-session-archive.json'),
  wsv2Script: process.env.WSV2_SCRIPT ?? path.join(os.homedir(), 'ai-workflow', 'workspace-v2', 'scripts', 'wsv2'),
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
  deepgramApiBase: process.env.DEEPGRAM_API_BASE ?? 'https://api.deepgram.com',
  deepgramSttModel: process.env.DEEPGRAM_STT_MODEL ?? 'nova-3',
  deepgramSttLanguage: process.env.DEEPGRAM_STT_LANGUAGE ?? 'pt-BR',
  deepgramTtsModel: process.env.DEEPGRAM_TTS_MODEL ?? 'aura-2-thalia-en',
  deepgramTtsEncoding: process.env.DEEPGRAM_TTS_ENCODING ?? 'mp3',
  deepgramTtsMaxChars: Number.parseInt(process.env.DEEPGRAM_TTS_MAX_CHARS ?? '2000', 10),
  voiceMaxAudioBytes: Number.parseInt(process.env.VOICE_MAX_AUDIO_BYTES ?? String(25 * 1024 * 1024), 10),
  vmCreateEnabled: String(process.env.VM_CREATE_ENABLED || '').toLowerCase() === 'true',
  pulumiBin: process.env.PULUMI_BIN ?? 'pulumi',
  pulumiWorkDir: process.env.PULUMI_WORK_DIR ?? path.join(os.homedir(), 'ai-workflow', 'infra', 'proxmox-test-vm'),
  vmCreateTimeoutMs: Number.parseInt(process.env.VM_CREATE_TIMEOUT_MS ?? String(20 * 60 * 1000), 10),
  vmIpPollAttempts: Number.parseInt(process.env.VM_IP_POLL_ATTEMPTS ?? '6', 10),
  vmIpPollIntervalMs: Number.parseInt(process.env.VM_IP_POLL_INTERVAL_MS ?? '10000', 10),
}
const DEFAULT_HISTORY_LINES = 1000
const MAX_HISTORY_LINES = 20000
const VM_CREATE_LOG_LIMIT = 300
const VM_TEMPLATE_NODES = {
  pve1: {
    node: 'pve1',
    templateVmId: 9013,
    templateName: 'debian13-cloud-template',
    storage: 'pve1-ssd-100G-1',
  },
  pve2: {
    node: 'pve2',
    templateVmId: 9014,
    templateName: 'debian13-cloud-template-pve2',
    storage: 'pve2-ssd-2T-1',
  },
  pve3: {
    node: 'pve3',
    templateVmId: 9015,
    templateName: 'debian13-cloud-template-pve3',
    storage: 'pve3-ssd-2T-1',
  },
}
const VM_CREATE_DEFAULTS = {
  node: 'pve1',
  cpuCores: 2,
  memoryMb: 4096,
  diskGb: 32,
  bridge: process.env.VM_CREATE_DEFAULT_BRIDGE ?? 'vmbr0',
  username: process.env.VM_CREATE_DEFAULT_USER ?? 'debian',
}
const storeFile = path.join(config.dataDir, 'sessions.json')
const userStoreFile = path.join(config.dataDir, 'users.json')
const sessionStore = new Map()
const userStoreById = new Map()
const userStoreByUsername = new Map()
const authTokens = new Map()
const vmCreateJobs = new Map()
const activeVmStacks = new Set()
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

const respondBinary = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    ...headers,
  })
  res.end(body)
}

class PayloadTooLargeError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 413
  }
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

const readRawBody = async (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    let settled = false

    req.on('data', (chunk) => {
      if (settled) {
        return
      }
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        settled = true
        reject(new PayloadTooLargeError('Audio payload exceeds limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
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

const normalizeWindowLabel = (value) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 80)
}

const normalizeWindowStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (['check', 'needs-check', 'needs_check', 'review'].includes(normalized)) {
    return 'check'
  }
  if (['idle', 'done', 'complete', 'completed'].includes(normalized)) {
    return 'idle'
  }
  return ''
}

const normalizeWindowId = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return ''
  }
  const normalized = raw.startsWith('@') ? raw.slice(1) : raw
  return /^\d+$/.test(normalized) ? `@${normalized}` : ''
}

const legacyWindowLabelKey = (hostId, sessionId, windowIndex) => `${hostId}:${sessionId}#${windowIndex}`

const windowLabelKey = (hostId, sessionId, windowIndex, windowId = '') => {
  const normalizedWindowId = normalizeWindowId(windowId)
  return normalizedWindowId
    ? `${hostId}:${sessionId}${normalizedWindowId}`
    : legacyWindowLabelKey(hostId, sessionId, windowIndex)
}

const readLauncherState = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(config.launcherStatePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { recent: {} }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to load launcher state ${config.launcherStatePath}:`, safeErrorMessage(error))
    }
    return { recent: {} }
  }
}

const writeLauncherState = async (payload) => {
  await fs.mkdir(path.dirname(config.launcherStatePath), { recursive: true })
  await fs.writeFile(config.launcherStatePath, JSON.stringify(payload, null, 2), 'utf8')
}

const readWindowLabels = async () => {
  const state = await readLauncherState()
  return state.windowLabels && typeof state.windowLabels === 'object' ? state.windowLabels : {}
}

const windowLabelCandidateKeys = (host, sessionId, windowIndex, windowId = '') => {
  const hostIds = new Set([host?.id, ...(host?.legacyIds || [])].filter(Boolean))
  if (isHostLocal(host)) {
    hostIds.add(config.mobileSelfHostId)
    hostIds.add('local')
  }
  const stableKeys = []
  const legacyKeys = []
  Array.from(hostIds).forEach((hostId) => {
    const stableKey = windowLabelKey(hostId, sessionId, windowIndex, windowId)
    stableKeys.push(stableKey)
    legacyKeys.push(legacyWindowLabelKey(hostId, sessionId, windowIndex))
  })
  return Array.from(new Set([...stableKeys, ...legacyKeys]))
}

const resolveWindowLabel = (labels, host, sessionId, windowIndex, windowId = '') => {
  for (const key of windowLabelCandidateKeys(host, sessionId, windowIndex, windowId)) {
    const label = normalizeWindowLabel(labels[key]?.label)
    if (label) {
      return label
    }
  }
  return ''
}

const resolveWindowStatus = (labels, host, sessionId, windowIndex, windowId = '') => {
  for (const key of windowLabelCandidateKeys(host, sessionId, windowIndex, windowId)) {
    const status = normalizeWindowStatus(labels[key]?.status)
    if (status) {
      return status
    }
  }
  return ''
}

const setWindowMetadata = async (host, sessionId, windowIndex, metadata = {}, windowId = '') => {
  const state = await readLauncherState()
  const labels = state.windowLabels && typeof state.windowLabels === 'object'
    ? state.windowLabels
    : {}
  state.windowLabels = labels

  const key = windowLabelKey(host.id, sessionId, windowIndex, windowId)
  const candidateKeys = windowLabelCandidateKeys(host, sessionId, windowIndex, windowId)
  const existingKey = candidateKeys.find((candidateKey) => (
    labels[candidateKey] && typeof labels[candidateKey] === 'object'
  ))
  const existing = existingKey ? labels[existingKey] : {}
  const hasLabelUpdate = Object.prototype.hasOwnProperty.call(metadata, 'label')
  const hasStatusUpdate = Object.prototype.hasOwnProperty.call(metadata, 'status')
  const normalizedLabel = hasLabelUpdate
    ? normalizeWindowLabel(metadata.label)
    : normalizeWindowLabel(existing.label)
  const normalizedStatus = hasStatusUpdate
    ? normalizeWindowStatus(metadata.status)
    : normalizeWindowStatus(existing.status)
  if (normalizedLabel || normalizedStatus) {
    labels[key] = {
      updatedAt: Math.floor(Date.now() / 1000),
    }
    if (normalizedLabel) {
      labels[key].label = normalizedLabel
    }
    if (normalizedStatus) {
      labels[key].status = normalizedStatus
    }
    candidateKeys.forEach((candidateKey) => {
      if (candidateKey !== key) {
        delete labels[candidateKey]
      }
    })
  } else {
    candidateKeys.forEach((candidateKey) => {
      delete labels[candidateKey]
    })
  }
  await writeLauncherState(state)
  return { label: normalizedLabel, status: normalizedStatus }
}

const decorateWindowWithLabel = (window, host, labels, sessionId = window.sessionId) => {
  const tmuxName = window.tmuxName || window.name || `window-${window.index}`
  const label = resolveWindowLabel(labels, host, sessionId, window.index, window.id)
  const status = resolveWindowStatus(labels, host, sessionId, window.index, window.id)
  const displayName = label || tmuxName
  return {
    ...window,
    tmuxName,
    label,
    status,
    displayName,
    name: displayName,
  }
}

const recentScoreForWindow = (state, host, sessionId, windowIndex, windowId = '') => {
  const recent = state.recent && typeof state.recent === 'object' ? state.recent : {}
  const keys = [
    ...windowLabelCandidateKeys(host, sessionId, windowIndex, windowId),
    `${host?.id}:${sessionId}`,
    sessionId,
  ]
  return Math.max(
    ...keys.map((key) => Number(recent[key] || 0)).filter((value) => Number.isFinite(value)),
    0,
  ) * 1000
}

const safeErrorMessage = (error) => {
  const message = error?.message ?? String(error)
  const cause = error?.cause?.code ?? error?.cause?.message
  return cause ? `${message} (${cause})` : message
}

const secretValuesForRedaction = () => [
  config.deepgramApiKey,
  process.env.PROXMOX_VE_API_TOKEN,
  process.env.PROXMOX_VE_PASSWORD,
  process.env.PULUMI_ACCESS_TOKEN,
  process.env.PULUMI_CONFIG_PASSPHRASE,
  process.env.PULUMI_CONFIG_PASSPHRASE_FILE,
].filter(Boolean)

const redactSecrets = (value) => {
  let redacted = String(value ?? '')
  secretValuesForRedaction().forEach((secret) => {
    if (secret) {
      redacted = redacted.replaceAll(secret, '[redacted]')
    }
  })
  return redacted
}

const sanitizeDeepgramToken = (value, fallback = '') => {
  const trimmed = String(value || fallback || '').trim()
  if (!trimmed) {
    return ''
  }
  const safe = trimmed.match(/[A-Za-z0-9._-]/g)
  if (!safe) {
    return ''
  }
  return safe.join('').slice(0, 80)
}

const sanitizeDeepgramLanguage = (value) => sanitizeDeepgramToken(value, config.deepgramSttLanguage).slice(0, 20)

const redactDeepgramSecret = (value) =>
  String(value || '').replaceAll(config.deepgramApiKey, '[redacted]')

const deepgramUrl = (pathName) => {
  const base = config.deepgramApiBase.endsWith('/')
    ? config.deepgramApiBase
    : `${config.deepgramApiBase}/`
  return new URL(pathName.replace(/^\//, ''), base)
}

const readDeepgramError = async (response) => {
  const raw = await response.text().catch(() => '')
  const detail = redactDeepgramSecret(raw).replace(/\s+/g, ' ').trim()
  return detail.slice(0, 500) || response.statusText || 'Deepgram request failed'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const shouldRetryDeepgramStatus = (status) =>
  status === 408 || status === 425 || status === 429 || status >= 500

const fetchDeepgram = async (url, options, { attempts = 3 } = {}) => {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (response.ok || attempt === attempts || !shouldRetryDeepgramStatus(response.status)) {
        return response
      }
      await response.arrayBuffer().catch(() => null)
    } catch (error) {
      lastError = error
      if (attempt === attempts) {
        throw error
      }
    }
    await sleep(250 * attempt)
  }
  throw lastError ?? new Error('Deepgram request failed')
}

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

const runTmux = async (args, options = {}) => {
  try {
    const result = await execFileAsync(config.tmuxBin, args, options)
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

const tmuxListWindows = async (sessionId, { host = null, labels = null } = {}) => {
  const response = await runTmux([
    'list-windows',
    '-t', sessionId,
    '-F', '#{window_index}|#{window_id}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}',
  ])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return []
    }
    throw response.error
  }
  const rows = response.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, windowId, name, active, activity, panes] = line.split('|')
      const activitySeconds = Number.parseInt(activity, 10)
      const paneCount = Number.parseInt(panes, 10)
      return {
        index: Number.parseInt(index, 10),
        id: normalizeWindowId(windowId),
        name: name || `window-${index}`,
        tmuxName: name || `window-${index}`,
        active: active === '1',
        lastActivityAt: Number.isFinite(activitySeconds) ? activitySeconds * 1000 : 0,
        paneCount: Number.isFinite(paneCount) ? paneCount : 0,
      }
    })
  if (!labels || !host) {
    return rows
  }
  return rows.map((window) => decorateWindowWithLabel(window, host, labels, sessionId))
}

const parseTmuxWindowRows = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sessionId, index, windowId, name, active, activity, panes] = line.split('|')
      const windowIndex = Number.parseInt(index, 10)
      const activitySeconds = Number.parseInt(activity, 10)
      const paneCount = Number.parseInt(panes, 10)
      if (!sessionId || !Number.isFinite(windowIndex)) {
        return null
      }
      return {
        sessionId,
        index: windowIndex,
        id: normalizeWindowId(windowId),
        name: name || `window-${index}`,
        tmuxName: name || `window-${index}`,
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
      id: window.id || '',
      name: window.name,
      tmuxName: window.tmuxName || window.name,
      label: window.label || '',
      status: window.status || '',
      displayName: window.displayName || window.name,
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
    '#{session_name}|#{window_index}|#{window_id}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}',
  ])
  if (!response.ok) {
    if (response.error?.code === 1) {
      return []
    }
    throw response.error
  }
  return parseTmuxWindowRows(response.stdout)
}

const runSsh = async (sshTarget, remoteCommand, timeout = 8000, options = {}) => {
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
      { timeout, maxBuffer: 1024 * 1024, ...options },
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
    `${config.tmuxBin} list-windows -a -F ${shellQuote('#{session_name}|#{window_index}|#{window_id}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}')} 2>/dev/null || true`,
  )
  if (!response.ok) {
    throw response.error
  }
  return parseTmuxWindowRows(response.stdout)
}

const parseHistoryLines = (value) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HISTORY_LINES
  }
  return Math.min(MAX_HISTORY_LINES, Math.max(100, parsed))
}

const buildTmuxWindowTarget = (sessionId, windowIndex, windowId = '') => {
  const normalizedWindowId = normalizeWindowId(windowId)
  if (normalizedWindowId) {
    return normalizedWindowId
  }
  return Number.isFinite(windowIndex) ? `${sessionId}:${windowIndex}` : sessionId
}

const tmuxCapturePaneHistory = async (sessionId, windowIndex, windowId, lines, { includeVisible = true } = {}) => {
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const response = await runTmux(
    [
      'capture-pane',
      '-p',
      '-J',
      '-S',
      `-${lines}`,
      '-E',
      includeVisible ? '-' : '-1',
      '-t',
      target,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  if (!response.ok) {
    throw response.error
  }
  return response.stdout
}

const remoteCapturePaneHistory = async (host, sessionId, windowIndex, windowId, lines, { includeVisible = true } = {}) => {
  if (!host?.ssh) {
    throw new Error('Host has no SSH target')
  }
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const command = [
    config.tmuxBin,
    'capture-pane',
    '-p',
    '-J',
    '-S',
    shellQuote(`-${lines}`),
    '-E',
    shellQuote(includeVisible ? '-' : '-1'),
    '-t',
    shellQuote(target),
  ].join(' ')
  const response = await runSsh(host.ssh, command, 10000, { maxBuffer: 8 * 1024 * 1024 })
  if (!response.ok) {
    throw response.error
  }
  return response.stdout
}

const splitTmuxInputPayload = (payload) => {
  const chunks = []
  let literal = ''
  const flushLiteral = () => {
    if (literal) {
      chunks.push({ type: 'literal', value: literal })
      literal = ''
    }
  }
  const keyByCharacter = new Map([
    ['\r', 'Enter'],
    ['\n', 'Enter'],
    ['\t', 'Tab'],
    ['\x03', 'C-c'],
    ['\x04', 'C-d'],
    ['\x1a', 'C-z'],
    ['\x1b', 'Escape'],
    ['\x7f', 'BSpace'],
    ['\b', 'BSpace'],
  ])

  Array.from(String(payload || '').replace(/\0/g, '')).forEach((character) => {
    const key = keyByCharacter.get(character)
    if (key) {
      flushLiteral()
      chunks.push({ type: 'key', value: key })
      return
    }
    literal += character
  })
  flushLiteral()
  return chunks
}

const tmuxSendInput = async (sessionId, windowIndex, windowId, payload) => {
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const chunks = splitTmuxInputPayload(payload)
  for (const chunk of chunks) {
    const response = await runTmux(
      chunk.type === 'literal'
        ? ['send-keys', '-t', target, '-l', chunk.value]
        : ['send-keys', '-t', target, chunk.value],
    )
    if (!response.ok) {
      throw response.error
    }
  }
}

const remoteSendInput = async (host, sessionId, windowIndex, windowId, payload) => {
  if (!host?.ssh) {
    throw new Error('Host has no SSH target')
  }
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const chunks = splitTmuxInputPayload(payload)
  const command = chunks.map((chunk) => (
    chunk.type === 'literal'
      ? `${config.tmuxBin} send-keys -t ${shellQuote(target)} -l ${shellQuote(chunk.value)}`
      : `${config.tmuxBin} send-keys -t ${shellQuote(target)} ${shellQuote(chunk.value)}`
  )).join(' && ')
  if (!command) {
    return
  }
  const response = await runSsh(host.ssh, command, 10000, { maxBuffer: 1024 * 1024 })
  if (!response.ok) {
    throw response.error
  }
}

const normalizeScrollLines = (value) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed === 0) {
    return 0
  }
  const bounded = Math.min(80, Math.max(-80, parsed))
  return bounded
}

const tmuxScrollPane = async (sessionId, windowIndex, windowId, lines) => {
  const normalizedLines = normalizeScrollLines(lines)
  if (!normalizedLines) {
    return false
  }
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const count = Math.abs(normalizedLines)
  const command = normalizedLines > 0 ? 'scroll-up' : 'scroll-down'
  const copyMode = await runTmux(['copy-mode', '-t', target])
  if (!copyMode.ok && copyMode.error?.code !== 1) {
    throw copyMode.error
  }
  const scroll = await runTmux(['send-keys', '-X', '-N', String(count), '-t', target, command])
  if (!scroll.ok && scroll.error?.code !== 1) {
    throw scroll.error
  }
  return scroll.ok
}

const tmuxCancelCopyMode = async (sessionId, windowIndex, windowId = '') => {
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const response = await runTmux(['send-keys', '-X', '-t', target, 'cancel'])
  if (!response.ok && response.error?.code !== 1) {
    throw response.error
  }
}

const remoteRunTmux = async (host, command, timeout = 8000) => {
  if (!host?.ssh) {
    throw new Error('Host has no SSH target')
  }
  const response = await runSsh(host.ssh, command, timeout)
  if (!response.ok) {
    throw response.error
  }
  return response
}

const remoteScrollPane = async (host, sessionId, windowIndex, windowId, lines) => {
  const normalizedLines = normalizeScrollLines(lines)
  if (!normalizedLines) {
    return false
  }
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const count = Math.abs(normalizedLines)
  const command = normalizedLines > 0 ? 'scroll-up' : 'scroll-down'
  await remoteRunTmux(
    host,
    [
      `${config.tmuxBin} copy-mode -t ${shellQuote(target)} 2>/dev/null || true`,
      `${config.tmuxBin} send-keys -X -N ${count} -t ${shellQuote(target)} ${shellQuote(command)} 2>/dev/null || true`,
    ].join('; '),
  )
  return true
}

const remoteCancelCopyMode = async (host, sessionId, windowIndex, windowId = '') => {
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  await remoteRunTmux(
    host,
    `${config.tmuxBin} send-keys -X -t ${shellQuote(target)} cancel 2>/dev/null || true`,
  )
}

const buildAgentTarget = (sessionId, windowIndex = null, windowId = '') => {
  if (!sessionId) {
    return null
  }
  const normalizedWindowId = normalizeWindowId(windowId)
  if (normalizedWindowId) {
    return `${sessionId}${normalizedWindowId}`
  }
  return Number.isFinite(windowIndex) ? `${sessionId}#${windowIndex}` : sessionId
}

const buildAgentCommand = ({
  action,
  sessionId = null,
  windowIndex = null,
  windowId = '',
  hostId,
  hostName,
  reason = null,
  jsonOutput = false,
  allTargets = false,
}) => {
  const target = buildAgentTarget(sessionId, windowIndex, windowId)
  return [
    'cd ~/ai-workflow',
    '&&',
    `WSV2_SELF_HOST=${shellQuote(hostId)}`,
    'workspace-v2/scripts/wsv2',
    'codex',
    shellQuote(action),
    target ? shellQuote(target) : null,
    allTargets ? '--all' : null,
    '--local-only',
    '--host-id',
    shellQuote(hostId),
    '--host-name',
    shellQuote(hostName || hostId),
    reason ? '--reason' : null,
    reason ? shellQuote(reason) : null,
    jsonOutput ? '--json' : null,
  ].filter(Boolean).join(' ')
}

const runHostAgentCommand = async (
  host,
  { action, sessionId = null, windowIndex = null, windowId = '', reason = null, jsonOutput = false, allTargets = false },
) => {
  if (!host?.id) {
    throw new Error('Host is required')
  }
  const target = buildAgentTarget(sessionId, windowIndex, windowId)
  if (host.ssh) {
    const command = buildAgentCommand({
      action,
      sessionId,
      windowIndex,
      windowId,
      hostId: host.id,
      hostName: host.name,
      reason,
      jsonOutput,
      allTargets,
    })
    const response = await runSsh(host.ssh, command, 20000, { maxBuffer: 4 * 1024 * 1024 })
    if (!response.ok) {
      throw response.error
    }
    return response.stdout
  }

  const args = ['codex', action]
  if (target) {
    args.push(target)
  }
  if (allTargets) {
    args.push('--all')
  }
  args.push('--local-only', '--host-id', host.id, '--host-name', host.name || host.id)
  if (reason) {
    args.push('--reason', reason)
  }
  if (jsonOutput) {
    args.push('--json')
  }
  const result = await execFileAsync(
    config.wsv2Script,
    args,
    {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        WSV2_SELF_HOST: host.id,
      },
    },
  )
  return result.stdout
}

const listHostAgents = async (host) => {
  const stdout = await runHostAgentCommand(host, { action: 'list', jsonOutput: true })
  try {
    const parsed = JSON.parse(stdout || '[]')
    if (Array.isArray(parsed)) {
      return parsed
    }
    if (Array.isArray(parsed.rows)) {
      return parsed.rows
    }
    return []
  } catch (error) {
    throw new Error(`Invalid agent list JSON: ${safeErrorMessage(error)}`)
  }
}

const summarizeWorkspaceAgents = (rows, sessionId) => {
  const matchingRows = rows.filter((row) => row?.session === sessionId)
  const agentCount = matchingRows.length
  const parkedAgentCount = matchingRows.filter((row) => row.parked).length
  const activeAgentCount = Math.max(0, agentCount - parkedAgentCount)
  let status = 'none'
  if (agentCount > 0 && parkedAgentCount === agentCount) {
    status = 'parked'
  } else if (parkedAgentCount > 0) {
    status = 'partial'
  } else if (agentCount > 0) {
    status = 'active'
  }
  return {
    count: agentCount,
    active: activeAgentCount,
    parked: parkedAgentCount,
    status,
  }
}

const unparkLocalAgents = async (sessionId, windowIndex, windowId = '') => {
  const selfHost = await findMobileHost(config.mobileSelfHostId)
  if (!selfHost) {
    throw new Error(`Self host not found: ${config.mobileSelfHostId}`)
  }
  await runHostAgentCommand(selfHost, { action: 'unpark', sessionId, windowIndex, windowId })
}

const unparkRemoteAgents = async (host, sessionId, windowIndex, windowId = '') => {
  await runHostAgentCommand(host, { action: 'unpark', sessionId, windowIndex, windowId })
}

const syncWindowStatusAgents = async ({ host, sessionId, windowIndex, windowId = '', previousStatus, nextStatus }) => {
  const previous = normalizeWindowStatus(previousStatus)
  const next = normalizeWindowStatus(nextStatus)
  if (previous === next || !Number.isFinite(windowIndex)) {
    return null
  }
  if (next === 'idle') {
    return {
      action: 'park',
      output: await runHostAgentCommand(
        host,
        { action: 'park', sessionId, windowIndex, windowId, reason: 'idle-status' },
      ),
    }
  }
  if (previous === 'idle') {
    return {
      action: 'unpark',
      output: await runHostAgentCommand(host, { action: 'unpark', sessionId, windowIndex, windowId }),
    }
  }
  return null
}

const setSessionWindowsStatus = async (host, sessionId, status) => {
  const labels = await readWindowLabels()
  const windows = await listHostSessionWindows(host, sessionId, labels)
  let updated = 0
  for (const window of windows) {
    if (!Number.isFinite(window.index)) {
      continue
    }
    await setWindowMetadata(host, sessionId, window.index, { status }, window.id)
    updated += 1
  }
  return updated
}

const tmuxSelectWindow = async (sessionId, windowIndex, windowId = '') => {
  const response = await runTmux(['select-window', '-t', buildTmuxWindowTarget(sessionId, windowIndex, windowId)])
  return response.ok
}

const tmuxGetWindowSize = async (sessionId, windowIndex = null, windowId = '') => {
  const target = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
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

const readOptionalJsonFile = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    console.warn(`Failed to load JSON file ${filePath}:`, safeErrorMessage(error))
    return null
  }
}

const hostMatchesId = (host, value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) {
    return false
  }
  if (host.id.toLowerCase() === normalized) {
    return true
  }
  return (host.legacyIds || []).some((legacyId) => String(legacyId).toLowerCase() === normalized)
}

const resolveCatalogHost = (hosts, hostIdRaw) => {
  const normalized = String(hostIdRaw || '').trim()
  if (!normalized) {
    return hosts.find((host) => host.id === config.mobileSelfHostId) ?? hosts[0] ?? null
  }
  return hosts.find((host) => hostMatchesId(host, normalized)) ?? null
}

const normalizeCatalogWorkspace = (workspace, hosts, source) => {
  const host = resolveCatalogHost(hosts, workspace.host ?? config.mobileSelfHostId)
  const id = sanitizeId(workspace.id)
  if (!host || !id) {
    return null
  }
  return {
    id,
    name: String(workspace.name || workspace.id),
    description: String(workspace.description || ''),
    path: normalizePath(workspace.path || ''),
    color: String(workspace.color || (source === 'archive' ? '#64748b' : '#3498db')),
    icon: String(workspace.icon || (source === 'archive' ? 'terminal' : 'folder')),
    hostId: host.id,
    source,
    archived: source === 'archive',
  }
}

const appendWorkspaceIfMissing = (workspaces, seenWorkspaces, workspace) => {
  if (!workspace) {
    return
  }
  const key = `${workspace.hostId}:${workspace.id}`
  if (seenWorkspaces.has(key)) {
    return
  }
  seenWorkspaces.add(key)
  workspaces.push(workspace)
}

const formatArchivedWorkspaceName = (sessionId) =>
  sessionId.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || sessionId

const loadArchiveWorkspaces = async (hosts, seenWorkspaces) => {
  const archive = await readOptionalJsonFile(config.sessionArchivePath)
  if (!archive || !Array.isArray(archive.records)) {
    return []
  }

  const selectedBySession = new Map()
  archive.records.forEach((record) => {
    const tmuxData = record?.tmux || {}
    const sessionId = sanitizeId(tmuxData.session)
    const host = resolveCatalogHost(hosts, record?.hostId)
    if (!sessionId || !host) {
      return
    }
    const key = `${host.id}:${sessionId}`
    if (seenWorkspaces.has(key)) {
      return
    }
    const score = Math.max(
      Number(record.activityAt || 0),
      Number(record.lastSeenAt || 0),
      Number(record.updatedAt || 0),
    )
    const previous = selectedBySession.get(key)
    if (!previous || score > previous.score) {
      selectedBySession.set(key, { score, host, record, sessionId })
    }
  })

  return Array.from(selectedBySession.values()).map(({ host, record, sessionId }) =>
    normalizeCatalogWorkspace(
      {
        id: sessionId,
        name: formatArchivedWorkspaceName(sessionId),
        description: 'Archived tmux session',
        path: record.cwd || record.tmux?.paneCwd || '',
        color: '#64748b',
        icon: 'terminal',
        host: host.id,
      },
      hosts,
      'archive',
    ),
  )
}

const loadMobileCatalog = async () => {
  const payload = await readOptionalJsonFile(config.mobileWorkspacesConfig)
  if (!payload) {
    throw new Error(`Workspace catalog not found: ${config.mobileWorkspacesConfig}`)
  }
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
  const workspaces = []
  const seenWorkspaces = new Set()
  if (Array.isArray(payload.workspaces)) {
    payload.workspaces.forEach((workspace) => {
      appendWorkspaceIfMissing(
        workspaces,
        seenWorkspaces,
        normalizeCatalogWorkspace(workspace, hosts, 'configured'),
      )
    })
  }

  const legacyPayload = await readOptionalJsonFile(config.workspacesConfig)
  if (legacyPayload && Array.isArray(legacyPayload.workspaces)) {
    legacyPayload.workspaces.forEach((workspace) => {
      appendWorkspaceIfMissing(
        workspaces,
        seenWorkspaces,
        normalizeCatalogWorkspace(workspace, hosts, 'legacy'),
      )
    })
  }

  const archivedWorkspaces = await loadArchiveWorkspaces(hosts, seenWorkspaces)
  archivedWorkspaces.forEach((workspace) => appendWorkspaceIfMissing(workspaces, seenWorkspaces, workspace))

  return { hosts, workspaces }
}

const decorateMobileWorkspace = ({ workspace, host, windows, active, agentSummary = null }) => {
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
    agents: agentSummary ?? {
      count: 0,
      active: 0,
      parked: 0,
      status: 'none',
    },
    connection: {
      type: isHostLocal(host) ? 'local' : 'remote',
      hostId: host.id,
      sessionId: workspace.id,
    },
  }
}

const buildHostMobileInventory = async (host, configuredWorkspaces, labels = {}) => {
  const rawWindowRows = isHostLocal(host)
    ? await tmuxListAllWindows()
    : await remoteListAllWindows(host)
  const windowRows = rawWindowRows.map((window) => decorateWindowWithLabel(window, host, labels))
  let agentRows = []
  try {
    agentRows = await listHostAgents(host)
  } catch (error) {
    console.warn(`Failed to list Codex/Claude agents for ${host.name}:`, safeErrorMessage(error))
  }
  const windowsBySession = groupWindowsBySession(windowRows)
  const activeSessionIds = new Set(windowsBySession.keys())
  const configuredIds = new Set(configuredWorkspaces.map((workspace) => workspace.id))
  const workspaces = configuredWorkspaces.map((workspace) =>
    decorateMobileWorkspace({
      workspace,
      host,
      windows: windowsBySession.get(workspace.id) ?? [],
      active: activeSessionIds.has(workspace.id),
      agentSummary: summarizeWorkspaceAgents(agentRows, workspace.id),
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
        agentSummary: summarizeWorkspaceAgents(agentRows, sessionId),
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
    const labels = await readWindowLabels()
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
        hosts.push(await buildHostMobileInventory(host, workspacesByHost.get(host.id) ?? [], labels))
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
            agents: {
              count: 0,
              active: 0,
              parked: 0,
              status: 'unknown',
            },
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

const workspaceBySessionForHost = (workspaces) => {
  const lookup = new Map()
  workspaces.forEach((workspace) => {
    if (!lookup.has(workspace.id)) {
      lookup.set(workspace.id, workspace)
    }
  })
  return lookup
}

const buildTerminalTabRecord = ({ host, workspace, window, selectedAt = 0 }) => {
  const workspaceName = workspace?.name ?? formatDiscoveredWorkspaceName(window.sessionId)
  const workspaceDescription = workspace?.description ?? 'Discovered tmux session'
  const lastActivityAt = window.lastActivityAt || 0
  return {
    id: windowLabelKey(host.id, window.sessionId, window.index, window.id),
    hostId: host.id,
    hostName: host.name,
    local: isHostLocal(host),
    sessionId: window.sessionId,
    workspaceId: window.sessionId,
    workspaceName,
    workspaceDescription,
    discovered: !workspace,
    windowIndex: window.index,
    windowId: window.id || '',
    tmuxName: window.tmuxName || window.name,
    label: window.label || '',
    status: window.status || '',
    displayName: window.displayName || window.name,
    windowName: window.displayName || window.name,
    windowActive: window.active,
    active: true,
    lastActivityAt,
    selectedAt,
    recentAt: Math.max(lastActivityAt, selectedAt),
    paneCount: window.paneCount ?? 0,
  }
}

const buildTerminalTabsForHost = async (host, configuredWorkspaces, labels, launcherState) => {
  const rawWindows = isHostLocal(host)
    ? await tmuxListAllWindows()
    : await remoteListAllWindows(host)
  const windows = rawWindows.map((window) => decorateWindowWithLabel(window, host, labels))
  const workspaceLookup = workspaceBySessionForHost(configuredWorkspaces)
  return windows.map((window) => buildTerminalTabRecord({
    host,
    workspace: workspaceLookup.get(window.sessionId),
    window,
    selectedAt: recentScoreForWindow(launcherState, host, window.sessionId, window.index, window.id),
  }))
}

const listHostSessionWindows = async (host, sessionId, labels) => {
  if (isHostLocal(host)) {
    return tmuxListWindows(sessionId, { host, labels })
  }
  const windows = await remoteListAllWindows(host)
  return windows
    .filter((window) => window.sessionId === sessionId)
    .map((window) => decorateWindowWithLabel(window, host, labels))
}

const handleTerminalTabs = async (res) => {
  try {
    const catalog = await loadMobileCatalog()
    const launcherState = await readLauncherState()
    const labels = launcherState.windowLabels && typeof launcherState.windowLabels === 'object'
      ? launcherState.windowLabels
      : {}
    const workspacesByHost = new Map()
    catalog.hosts.forEach((host) => workspacesByHost.set(host.id, []))
    catalog.workspaces.forEach((workspace) => {
      if (!workspacesByHost.has(workspace.hostId)) {
        workspacesByHost.set(workspace.hostId, [])
      }
      workspacesByHost.get(workspace.hostId).push(workspace)
    })

    const tabs = []
    const errors = []
    for (const host of catalog.hosts) {
      try {
        tabs.push(...await buildTerminalTabsForHost(
          host,
          workspacesByHost.get(host.id) ?? [],
          labels,
          launcherState,
        ))
      } catch (error) {
        errors.push({ hostId: host.id, hostName: host.name, error: safeErrorMessage(error) })
      }
    }

    tabs.sort((left, right) => {
      if (right.recentAt !== left.recentAt) {
        return right.recentAt - left.recentAt
      }
      if (left.hostName !== right.hostName) {
        return left.hostName.localeCompare(right.hostName)
      }
      if (left.workspaceName !== right.workspaceName) {
        return left.workspaceName.localeCompare(right.workspaceName)
      }
      return left.windowIndex - right.windowIndex
    })

    respond(res, 200, {
      scannedAt: new Date().toISOString(),
      tabs,
      errors,
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error), tabs: [] })
  }
}

const handleSetTerminalTabLabel = async (req, res, hostIdRaw, sessionIdRaw, windowIndexRaw) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const windowIndex = Number.parseInt(windowIndexRaw, 10)
  const host = await findMobileHost(hostIdRaw)
  if (!host) {
    respond(res, 404, { error: 'Host not found' })
    return
  }
  if (!sanitizedSessionId || !Number.isFinite(windowIndex)) {
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

  try {
    const labels = await readWindowLabels()
    const windows = await listHostSessionWindows(host, sanitizedSessionId, labels)
    const requestedWindowId = normalizeWindowId(body.windowId)
    const existingWindow = windows.find((window) => (
      requestedWindowId && window.id === requestedWindowId
    )) ?? windows.find((window) => window.index === windowIndex)
    if (!existingWindow) {
      respond(res, 404, { error: 'Window not found' })
      return
    }
    const resolvedWindowIndex = existingWindow.index
    const metadata = {}
    if (Object.prototype.hasOwnProperty.call(body, 'label') || Object.prototype.hasOwnProperty.call(body, 'name')) {
      metadata.label = body.label ?? body.name
    }
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      metadata.status = body.status
    }
    const previousStatus = resolveWindowStatus(labels, host, sanitizedSessionId, resolvedWindowIndex, existingWindow.id)
    const savedMetadata = await setWindowMetadata(host, sanitizedSessionId, resolvedWindowIndex, metadata, existingWindow.id)
    let agentAction = null
    let agentActionError = null
    if (Object.prototype.hasOwnProperty.call(metadata, 'status')) {
      try {
        agentAction = await syncWindowStatusAgents({
          host,
          sessionId: sanitizedSessionId,
          windowIndex: resolvedWindowIndex,
          windowId: existingWindow.id,
          previousStatus,
          nextStatus: savedMetadata.status,
        })
      } catch (error) {
        agentActionError = safeErrorMessage(error)
        console.warn('Failed to sync terminal idle agent state', agentActionError)
      }
    }
    const updatedLabels = await readWindowLabels()
    const catalog = await loadMobileCatalog()
    const workspace = catalog.workspaces.find(
      (item) => item.hostId === host.id && item.id === sanitizedSessionId,
    )
    const updatedWindow = decorateWindowWithLabel(
      {
        ...existingWindow,
        name: existingWindow.tmuxName || existingWindow.name,
      },
      host,
      updatedLabels,
      sanitizedSessionId,
    )
    const launcherState = await readLauncherState()
    respond(res, 200, {
      tab: buildTerminalTabRecord({
        host,
        workspace,
        window: { ...updatedWindow, sessionId: sanitizedSessionId },
        selectedAt: recentScoreForWindow(launcherState, host, sanitizedSessionId, resolvedWindowIndex, existingWindow.id),
      }),
      agentAction,
      agentActionError,
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error) })
  }
}

const handleMobileHistory = async (res, hostIdRaw, sessionIdRaw, searchParams) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const windowIndexRaw = searchParams.get('windowIndex')
  const windowIndex = windowIndexRaw !== null ? Number.parseInt(windowIndexRaw, 10) : null
  const windowId = normalizeWindowId(searchParams.get('windowId'))
  const lines = parseHistoryLines(searchParams.get('lines'))
  const includeVisible = ['1', 'true', 'yes'].includes(
    (searchParams.get('includeVisible') ?? '').toLowerCase(),
  )
  const host = await findMobileHost(hostIdRaw)

  if (!host) {
    respond(res, 404, { error: 'Host not found' })
    return
  }
  if (!sanitizedSessionId) {
    respond(res, 400, { error: 'Invalid session id' })
    return
  }
  if (windowIndexRaw !== null && !Number.isFinite(windowIndex)) {
    respond(res, 400, { error: 'Invalid window index' })
    return
  }

  try {
    const text = isHostLocal(host)
      ? await tmuxCapturePaneHistory(sanitizedSessionId, windowIndex, windowId, lines, { includeVisible })
      : await remoteCapturePaneHistory(host, sanitizedSessionId, windowIndex, windowId, lines, { includeVisible })

    respond(res, 200, {
      hostId: host.id,
      hostName: host.name,
      sessionId: sanitizedSessionId,
      windowIndex,
      windowId,
      lines,
      includeVisible,
      text,
      capturedAt: new Date().toISOString(),
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error) })
  }
}

const handleMobileInput = async (req, res, hostIdRaw, sessionIdRaw) => {
  const host = await findMobileHost(hostIdRaw)
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  if (!host) {
    respond(res, 404, { error: 'Host not found' })
    return
  }
  if (!sanitizedSessionId) {
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

  const payload = String(body.payload || '').slice(0, 8000)
  const windowIndex = body.windowIndex !== undefined && body.windowIndex !== null
    ? Number.parseInt(body.windowIndex, 10)
    : null
  const windowId = normalizeWindowId(body.windowId)

  if (!payload) {
    respond(res, 400, { error: 'Input payload is required' })
    return
  }
  if (body.windowIndex !== undefined && body.windowIndex !== null && !Number.isFinite(windowIndex)) {
    respond(res, 400, { error: 'Invalid window index' })
    return
  }

  try {
    if (isHostLocal(host)) {
      await tmuxSendInput(sanitizedSessionId, windowIndex, windowId, payload)
    } else {
      await remoteSendInput(host, sanitizedSessionId, windowIndex, windowId, payload)
    }
    respond(res, 200, {
      ok: true,
      hostId: host.id,
      sessionId: sanitizedSessionId,
      windowIndex,
      windowId,
      bytes: Buffer.byteLength(payload),
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error) })
  }
}

const handleMobileAgentAction = async (req, res, hostIdRaw, sessionIdRaw) => {
  const host = await findMobileHost(hostIdRaw)
  const sessionId = sanitizeId(sessionIdRaw)
  if (!host) {
    respond(res, 404, { error: 'Host not found' })
    return
  }
  if (!sessionId) {
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
  const action = String(body.action || '').trim().toLowerCase()
  if (!['park', 'unpark'].includes(action)) {
    respond(res, 400, { error: 'Action must be park or unpark' })
    return
  }

  try {
    let stdout = ''
    let statusSyncError = null
    let windowsUpdated = 0
    try {
      stdout = await runHostAgentCommand(host, { action, sessionId })
    } catch (actionError) {
      const rows = await listHostAgents(host).catch(() => [])
      respond(res, 409, {
        error: safeErrorMessage(actionError),
        hostId: host.id,
        hostName: host.name,
        sessionId,
        action,
        agents: summarizeWorkspaceAgents(rows, sessionId),
        rows: rows.filter((row) => row?.session === sessionId),
      })
      return
    }
    try {
      windowsUpdated = await setSessionWindowsStatus(host, sessionId, action === 'park' ? 'idle' : '')
    } catch (error) {
      statusSyncError = safeErrorMessage(error)
      console.warn('Failed to sync workspace terminal status flags', statusSyncError)
    }
    const rows = await listHostAgents(host)
    respond(res, 200, {
      hostId: host.id,
      hostName: host.name,
      sessionId,
      action,
      output: stdout,
      windowsUpdated,
      statusSyncError,
      agents: summarizeWorkspaceAgents(rows, sessionId),
      rows: rows.filter((row) => row?.session === sessionId),
    })
  } catch (error) {
    respond(res, 500, { error: safeErrorMessage(error) })
  }
}

const serializeVmTemplates = () => ({
  enabled: config.vmCreateEnabled,
  defaults: VM_CREATE_DEFAULTS,
  nodes: Object.values(VM_TEMPLATE_NODES),
  network: {
    mode: 'dhcp',
    ipDetection: 'qemu-guest-agent',
  },
})

const handleVmTemplates = (res) => {
  respond(res, 200, serializeVmTemplates())
}

const sanitizeVmName = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!normalized || normalized.length > 48 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(normalized)) {
    return ''
  }
  return normalized
}

const parseBoundedInteger = (value, { min, max, fallback = null }) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, parsed))
}

const validateSshPublicKey = (value) => {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return ''
  }
  const parts = normalized.split(/\s+/)
  if (parts.length < 2) {
    return ''
  }
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(parts[0])) {
    return ''
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(parts[1])) {
    return ''
  }
  return normalized.slice(0, 4096)
}

const buildVmSpec = (body) => {
  const node = String(body?.node || VM_CREATE_DEFAULTS.node).trim()
  const template = VM_TEMPLATE_NODES[node]
  if (!template) {
    throw new Error('Node must be one of pve1, pve2, or pve3.')
  }

  const name = sanitizeVmName(body?.name)
  if (!name) {
    throw new Error('VM name must be 3-48 lowercase hostname characters.')
  }

  const cpuCores = parseBoundedInteger(body?.cpuCores, { min: 1, max: 16 })
  const memoryMb = parseBoundedInteger(body?.memoryMb, { min: 512, max: 65536 })
  const diskGb = parseBoundedInteger(body?.diskGb, { min: 8, max: 2048 })
  if (!cpuCores || !memoryMb || !diskGb) {
    throw new Error('CPU, memory, and disk values are required.')
  }

  const sshPublicKey = validateSshPublicKey(body?.sshPublicKey)
  if (!sshPublicKey) {
    throw new Error('A valid SSH public key is required.')
  }

  const bridge = String(body?.bridge || VM_CREATE_DEFAULTS.bridge).trim()
  if (!/^[A-Za-z0-9_.:-]{2,32}$/.test(bridge)) {
    throw new Error('Invalid network bridge.')
  }

  const username = String(body?.username || VM_CREATE_DEFAULTS.username).trim()
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
    throw new Error('Invalid cloud-init username.')
  }

  const description = String(body?.description || '').trim().slice(0, 240)
  return {
    name,
    node,
    cpuCores,
    memoryMb,
    diskGb,
    bridge,
    username,
    sshPublicKey,
    description,
    networkMode: 'dhcp',
    template,
  }
}

const serializeVmJob = (job) => ({
  id: job.id,
  stackName: job.stackName,
  status: job.status,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  finishedAt: job.finishedAt || null,
  spec: job.spec
    ? {
        name: job.spec.name,
        node: job.spec.node,
        cpuCores: job.spec.cpuCores,
        memoryMb: job.spec.memoryMb,
        diskGb: job.spec.diskGb,
        bridge: job.spec.bridge,
        username: job.spec.username,
        description: job.spec.description,
        networkMode: job.spec.networkMode,
        template: job.spec.template,
      }
    : null,
  vm: job.vm || null,
  ipStatus: job.ipStatus || 'pending',
  logs: job.logs || [],
  error: job.error || '',
})

const appendVmJobLog = (job, line) => {
  const cleaned = redactSecrets(line).replace(/\r/g, '').trimEnd()
  if (!cleaned) {
    return
  }
  job.logs.push(cleaned)
  if (job.logs.length > VM_CREATE_LOG_LIMIT) {
    job.logs.splice(0, job.logs.length - VM_CREATE_LOG_LIMIT)
  }
  job.updatedAt = new Date().toISOString()
}

const runPulumiJobCommand = (job, args, { timeoutMs = config.vmCreateTimeoutMs, allowFailure = false } = {}) =>
  new Promise((resolve, reject) => {
    appendVmJobLog(job, `$ ${config.pulumiBin} ${args.join(' ')}`)
    const child = spawn(config.pulumiBin, args, {
      cwd: config.pulumiWorkDir,
      env: {
        ...process.env,
        PULUMI_SKIP_UPDATE_CHECK: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM')
      if (!settled) {
        settled = true
        reject(new Error(`Pulumi command timed out after ${timeoutMs}ms.`))
      }
    }, timeoutMs)

    const collect = (chunk, target) => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        stdout += text
      } else {
        stderr += text
      }
      text.split(/\n/).forEach((line) => appendVmJobLog(job, line))
    }

    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'))
    child.on('error', (error) => {
      clearTimeout(timeoutId)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timeoutId)
      if (settled) {
        return
      }
      settled = true
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr })
        return
      }
      reject(new Error(`Pulumi command failed with exit code ${code}.`))
    })
  })

const parsePulumiOutputs = (raw) => {
  try {
    const parsed = JSON.parse(raw || '{}')
    const valueFor = (key) => {
      const output = parsed[key]
      if (output && typeof output === 'object' && Object.prototype.hasOwnProperty.call(output, 'value')) {
        return output.value
      }
      return output
    }
    const ipAddresses = valueFor('ipAddresses')
    const ipv4 = valueFor('ipv4')
    const vmId = valueFor('vmId')
    return {
      ipAddresses: Array.isArray(ipAddresses) ? ipAddresses : [],
      ipv4: typeof ipv4 === 'string' ? ipv4 : '',
      vmId: vmId ?? null,
    }
  } catch {
    return { ipAddresses: [], ipv4: '', vmId: null }
  }
}

const refreshVmIp = async (job) => {
  for (let attempt = 1; attempt <= config.vmIpPollAttempts; attempt += 1) {
    job.ipStatus = 'pending'
    appendVmJobLog(job, `Checking DHCP IP (${attempt}/${config.vmIpPollAttempts})...`)
    await runPulumiJobCommand(job, ['refresh', '--yes', '--non-interactive', '--stack', job.stackName], {
      timeoutMs: Math.min(config.vmCreateTimeoutMs, 5 * 60 * 1000),
      allowFailure: true,
    })
    const outputs = await runPulumiJobCommand(job, ['stack', 'output', '--json', '--stack', job.stackName], {
      timeoutMs: 60 * 1000,
      allowFailure: true,
    })
    const parsed = parsePulumiOutputs(outputs.stdout)
    if (parsed.vmId || parsed.ipv4 || parsed.ipAddresses.length) {
      job.vm = {
        ...(job.vm || {}),
        vmId: parsed.vmId ?? job.vm?.vmId ?? null,
        ipv4: parsed.ipv4 || job.vm?.ipv4 || '',
        ipAddresses: parsed.ipAddresses.length ? parsed.ipAddresses : (job.vm?.ipAddresses || []),
      }
    }
    if (parsed.ipv4) {
      job.ipStatus = 'found'
      return
    }
    if (attempt < config.vmIpPollAttempts) {
      await sleep(config.vmIpPollIntervalMs)
    }
  }
  job.ipStatus = 'unavailable'
}

const runVmCreateJob = async (job) => {
  activeVmStacks.add(job.stackName)
  try {
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    await fs.access(config.pulumiWorkDir)
    await runPulumiJobCommand(job, ['stack', 'select', job.stackName, '--create'])
    await runPulumiJobCommand(job, ['config', 'set', 'spec', JSON.stringify(job.spec), '--plaintext', '--stack', job.stackName])
    await runPulumiJobCommand(job, ['up', '--yes', '--skip-preview', '--non-interactive', '--stack', job.stackName])
    const outputs = await runPulumiJobCommand(job, ['stack', 'output', '--json', '--stack', job.stackName], {
      timeoutMs: 60 * 1000,
      allowFailure: true,
    })
    const parsed = parsePulumiOutputs(outputs.stdout)
    job.vm = {
      name: job.spec.name,
      node: job.spec.node,
      vmId: parsed.vmId,
      ipv4: parsed.ipv4,
      ipAddresses: parsed.ipAddresses,
    }
    job.ipStatus = parsed.ipv4 ? 'found' : 'pending'
    if (!parsed.ipv4) {
      await refreshVmIp(job)
    }
    job.status = 'succeeded'
    job.finishedAt = new Date().toISOString()
    job.updatedAt = job.finishedAt
  } catch (error) {
    job.status = 'failed'
    job.error = redactSecrets(safeErrorMessage(error))
    job.finishedAt = new Date().toISOString()
    job.updatedAt = job.finishedAt
    appendVmJobLog(job, `ERROR: ${job.error}`)
  } finally {
    activeVmStacks.delete(job.stackName)
  }
}

const handleVmCreate = async (req, res) => {
  if (!config.vmCreateEnabled) {
    respond(res, 403, { error: 'VM creation is disabled on this server.' })
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }

  let spec
  try {
    spec = buildVmSpec(body)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }

  const id = randomUUID()
  const suffix = id.split('-')[0]
  const stackName = `${spec.name}-${suffix}`
  if (activeVmStacks.has(stackName)) {
    respond(res, 409, { error: 'A VM create job for this stack is already running.' })
    return
  }

  const now = new Date().toISOString()
  const job = {
    id,
    stackName,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    finishedAt: '',
    spec,
    vm: null,
    ipStatus: 'pending',
    logs: [],
    error: '',
  }
  vmCreateJobs.set(id, job)
  runVmCreateJob(job)
  respond(res, 202, { job: serializeVmJob(job) })
}

const handleGetVmCreateJob = (res, jobIdRaw) => {
  const jobId = String(jobIdRaw || '').trim()
  const job = vmCreateJobs.get(jobId)
  if (!job) {
    respond(res, 404, { error: 'VM create job not found.' })
    return
  }
  respond(res, 200, { job: serializeVmJob(job) })
}

const handleVoiceStatus = (res) => {
  respond(res, 200, {
    deepgram: {
      configured: Boolean(config.deepgramApiKey),
      sttModel: config.deepgramSttModel,
      sttLanguage: config.deepgramSttLanguage,
      ttsModel: config.deepgramTtsModel,
      ttsEncoding: config.deepgramTtsEncoding,
      ttsMaxChars: config.deepgramTtsMaxChars,
      maxAudioBytes: config.voiceMaxAudioBytes,
    },
  })
}

const handleVoiceTranscribe = async (req, res, searchParams) => {
  if (!config.deepgramApiKey) {
    respond(res, 503, { error: 'Deepgram API key is not configured on the server.' })
    return
  }

  let audio
  try {
    audio = await readRawBody(req, config.voiceMaxAudioBytes)
  } catch (error) {
    respond(res, error.statusCode || 400, { error: safeErrorMessage(error) })
    return
  }

  if (!audio.length) {
    respond(res, 400, { error: 'Audio payload is empty.' })
    return
  }

  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0]
  const url = deepgramUrl('/v1/listen')
  const language = sanitizeDeepgramLanguage(searchParams.get('language'))
  url.searchParams.set('model', sanitizeDeepgramToken(config.deepgramSttModel, 'nova-3'))
  if (language) {
    url.searchParams.set('language', language)
  }
  url.searchParams.set('smart_format', 'true')
  url.searchParams.set('punctuate', 'true')

  try {
    const response = await fetchDeepgram(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: audio,
    })

    if (!response.ok) {
      const detail = await readDeepgramError(response)
      respond(res, 502, { error: `Deepgram transcription failed (${response.status}): ${detail}` })
      return
    }

    const payload = await response.json()
    const channel = payload.results?.channels?.[0]
    const transcript = channel?.alternatives?.[0]?.transcript ?? ''
    respond(res, 200, {
      provider: 'deepgram',
      text: transcript,
      language: channel?.detected_language ?? language,
      duration: payload.metadata?.duration ?? 0,
      requestId: payload.metadata?.request_id ?? null,
    })
  } catch (error) {
    respond(res, 502, { error: `Deepgram transcription failed: ${safeErrorMessage(error)}` })
  }
}

const handleVoiceTts = async (req, res) => {
  if (!config.deepgramApiKey) {
    respond(res, 503, { error: 'Deepgram API key is not configured on the server.' })
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch (error) {
    respond(res, 400, { error: error.message })
    return
  }

  const text = String(body.text || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    respond(res, 400, { error: 'Text is required.' })
    return
  }
  if (text.length > config.deepgramTtsMaxChars) {
    respond(res, 413, { error: `Text exceeds ${config.deepgramTtsMaxChars} characters.` })
    return
  }

  const model = sanitizeDeepgramToken(body.model, config.deepgramTtsModel) || 'aura-2-thalia-en'
  const encoding = sanitizeDeepgramToken(body.encoding, config.deepgramTtsEncoding) || 'mp3'
  const url = deepgramUrl('/v1/speak')
  url.searchParams.set('model', model)
  url.searchParams.set('encoding', encoding)

  try {
    const response = await fetchDeepgram(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    })

    if (!response.ok) {
      const detail = await readDeepgramError(response)
      respond(res, 502, { error: `Deepgram speech failed (${response.status}): ${detail}` })
      return
    }

    const audio = Buffer.from(await response.arrayBuffer())
    respondBinary(res, 200, audio, {
      'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Deepgram-Request-Id': response.headers.get('dg-request-id') || '',
      'X-Deepgram-Model': response.headers.get('dg-model-name') || model,
    })
  } catch (error) {
    respond(res, 502, { error: `Deepgram speech failed: ${safeErrorMessage(error)}` })
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
    const legacyPayload = await readOptionalJsonFile(config.workspacesConfig)
    const catalog = await loadMobileCatalog()
    const localHostIds = new Set(catalog.hosts.filter((host) => isHostLocal(host)).map((host) => host.id))

    // Enrich with session status
    const activeSessions = await tmuxListSessions()
    const activeSet = new Set(activeSessions)

    const configuredWorkspaces = catalog.workspaces
      .filter((workspace) => localHostIds.has(workspace.hostId))
      .map((workspace) => ({
        ...workspace,
        host: workspace.hostId,
      }))
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

    respond(res, 200, { workspaces, settings: legacyPayload?.settings || {} })
  } catch (error) {
    respond(res, 500, { error: error.message })
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
    const catalog = await loadMobileCatalog()
    const host = catalog.hosts.find((item) => isHostLocal(item)) ?? {
      id: config.mobileSelfHostId,
      name: 'Local',
      legacyIds: ['local'],
    }
    const labels = await readWindowLabels()
    const windows = await tmuxListWindows(sanitizedId, { host, labels })
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

  try {
    const catalog = await loadMobileCatalog()
    const host = catalog.hosts.find((item) => isHostLocal(item)) ?? {
      id: config.mobileSelfHostId,
      name: 'Local',
      legacyIds: ['local'],
    }
    const labels = await readWindowLabels()
    const existingWindows = await tmuxListWindows(sanitizedId, { host, labels })
    const requestedWindowId = normalizeWindowId(body.windowId)
    const existingWindow = existingWindows.find((window) => (
      requestedWindowId && window.id === requestedWindowId
    )) ?? existingWindows.find((window) => window.index === windowIndex)
    if (!existingWindow) {
      respond(res, 404, { error: 'Window not found' })
      return
    }
    const resolvedWindowIndex = existingWindow.index
    const metadata = {}
    if (Object.prototype.hasOwnProperty.call(body, 'label') || Object.prototype.hasOwnProperty.call(body, 'name')) {
      metadata.label = body.label ?? body.name
    }
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      metadata.status = body.status
    }
    const previousStatus = resolveWindowStatus(labels, host, sanitizedId, resolvedWindowIndex, existingWindow.id)
    const savedMetadata = await setWindowMetadata(host, sanitizedId, resolvedWindowIndex, metadata, existingWindow.id)
    let agentAction = null
    let agentActionError = null
    if (Object.prototype.hasOwnProperty.call(metadata, 'status')) {
      try {
        agentAction = await syncWindowStatusAgents({
          host,
          sessionId: sanitizedId,
          windowIndex: resolvedWindowIndex,
          windowId: existingWindow.id,
          previousStatus,
          nextStatus: savedMetadata.status,
        })
      } catch (error) {
        agentActionError = safeErrorMessage(error)
        console.warn('Failed to sync terminal idle agent state', agentActionError)
      }
    }
    const updatedLabels = await readWindowLabels()
    const windows = await tmuxListWindows(sanitizedId, { host, labels: updatedLabels })
    respond(res, 200, { sessionId: sanitizedId, windows, agentAction, agentActionError })
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
  if (method === 'GET' && pathName === '/terminal-tabs') {
    await handleTerminalTabs(res)
    return
  }
  if (method === 'GET' && pathName === '/vm-templates') {
    handleVmTemplates(res)
    return
  }
  if (method === 'POST' && pathName === '/vm-create') {
    await handleVmCreate(req, res)
    return
  }
  const vmCreateJobMatch = pathName.match(/^\/vm-create\/([^/]+)$/)
  if (vmCreateJobMatch && method === 'GET') {
    handleGetVmCreateJob(res, vmCreateJobMatch[1])
    return
  }
  const terminalTabLabelMatch = pathName.match(/^\/terminal-tabs\/([^/]+)\/([^/]+)\/([^/]+)\/label$/)
  if (terminalTabLabelMatch && method === 'PUT') {
    await handleSetTerminalTabLabel(
      req,
      res,
      terminalTabLabelMatch[1],
      terminalTabLabelMatch[2],
      terminalTabLabelMatch[3],
    )
    return
  }
  if (method === 'GET' && pathName === '/voice/status') {
    handleVoiceStatus(res)
    return
  }
  if (method === 'POST' && pathName === '/voice/transcribe') {
    await handleVoiceTranscribe(req, res, parsed.searchParams)
    return
  }
  if (method === 'POST' && pathName === '/voice/tts') {
    await handleVoiceTts(req, res)
    return
  }
  const mobileHistoryMatch = pathName.match(/^\/mobile\/history\/([^/]+)\/([^/]+)$/)
  if (mobileHistoryMatch && method === 'GET') {
    await handleMobileHistory(res, mobileHistoryMatch[1], mobileHistoryMatch[2], parsed.searchParams)
    return
  }
  const mobileInputMatch = pathName.match(/^\/mobile\/input\/([^/]+)\/([^/]+)$/)
  if (mobileInputMatch && method === 'POST') {
    await handleMobileInput(req, res, mobileInputMatch[1], mobileInputMatch[2])
    return
  }
  const mobileAgentMatch = pathName.match(/^\/mobile\/agents\/([^/]+)\/([^/]+)$/)
  if (mobileAgentMatch && method === 'POST') {
    await handleMobileAgentAction(req, res, mobileAgentMatch[1], mobileAgentMatch[2])
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
  const windowId = normalizeWindowId(searchParams.get('windowId'))
  const initialColsRaw = searchParams.get('cols')
  const initialRowsRaw = searchParams.get('rows')
  const monitorFlag = (searchParams.get('monitor') ?? '').toLowerCase()
  return {
    windowIndex: windowIndexRaw !== null ? Number.parseInt(windowIndexRaw, 10) : null,
    windowId,
    initialCols: initialColsRaw !== null ? Number.parseInt(initialColsRaw, 10) : null,
    initialRows: initialRowsRaw !== null ? Number.parseInt(initialRowsRaw, 10) : null,
    monitorMode: monitorFlag === '1' || monitorFlag === 'true',
  }
}

const handleTerminalSocket = async (ws, sessionIdRaw, searchParams) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const sanitizedProjectId = sanitizeId(searchParams.get('projectId'))
  const { windowIndex, windowId, initialCols, initialRows, monitorMode } = parseTerminalSocketOptions(searchParams)

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

  if (!monitorMode) {
    try {
      await unparkLocalAgents(sanitizedSessionId, windowIndex, windowId)
    } catch (error) {
      console.warn('Failed to unpark local Codex/Claude agents', safeErrorMessage(error))
    }
  }

  // Select specific window if requested
  if (windowId || (windowIndex !== null && Number.isFinite(windowIndex))) {
    try {
      const selectedWindow = await tmuxSelectWindow(sanitizedSessionId, windowIndex, windowId)
      if (!selectedWindow) {
        sendWsMessage(ws, { type: 'error', message: 'Requested tmux window is no longer available' })
        ws.close(1008, 'Window unavailable')
        return
      }
    } catch (error) {
      console.warn('Failed to select window', error.message)
      sendWsMessage(ws, { type: 'error', message: 'Unable to select requested tmux window' })
      ws.close(1011, 'Window unavailable')
      return
    }
  }

  let initialSize = null
  if (monitorMode) {
    try {
      initialSize = await tmuxGetWindowSize(sanitizedSessionId, windowIndex, windowId)
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
  let copyModeActive = false
  const attachTarget = sanitizedSessionId
  try {
    ptyProcess = pty.spawn(
      config.tmuxBin,
      ['attach-session', '-t', attachTarget],
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

  const writeInput = async (payload) => {
    if (copyModeActive) {
      copyModeActive = false
      try {
        await tmuxCancelCopyMode(sanitizedSessionId, windowIndex, windowId)
        await sleep(50)
      } catch (error) {
        console.warn('Failed to leave tmux copy mode', safeErrorMessage(error))
      }
    }
    ptyProcess?.write(payload)
  }

  const scrollPane = async (lines) => {
    try {
      const scrolled = await tmuxScrollPane(sanitizedSessionId, windowIndex, windowId, lines)
      copyModeActive = copyModeActive || scrolled
    } catch (error) {
      console.warn('Failed to scroll tmux pane', safeErrorMessage(error))
    }
  }

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
      writeInput(incoming.payload)
      return
    }
    if (incoming.type === 'scroll') {
      if (!monitorMode) {
        scrollPane(incoming.lines)
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
  return catalog.hosts.find((host) => hostMatchesId(host, sanitizedHostId)) ?? null
}

const buildRemoteAttachCommand = ({ sessionId, windowIndex, windowId = '' }) => {
  const sessionTarget = shellQuote(sessionId)
  const windowTarget = buildTmuxWindowTarget(sessionId, windowIndex, windowId)
  const commands = [
    `(${config.tmuxBin} has-session -t ${sessionTarget} 2>/dev/null || ${config.tmuxBin} new-session -d -s ${sessionTarget})`,
  ]
  if (windowTarget !== sessionId) {
    commands.push(`${config.tmuxBin} select-window -t ${shellQuote(windowTarget)}`)
  }
  commands.push(`exec ${config.tmuxBin} attach-session -t ${sessionTarget}`)
  return commands.join(' && ')
}

const handleRemoteTerminalSocket = async (ws, hostIdRaw, sessionIdRaw, searchParams) => {
  const sanitizedSessionId = sanitizeId(sessionIdRaw)
  const host = await findMobileHost(hostIdRaw)
  const { windowIndex, windowId, initialCols, initialRows, monitorMode } = parseTerminalSocketOptions(searchParams)

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
  let copyModeActive = false

  if (!monitorMode) {
    try {
      await unparkRemoteAgents(host, sanitizedSessionId, windowIndex, windowId)
    } catch (error) {
      console.warn('Failed to unpark remote Codex/Claude agents', safeErrorMessage(error))
    }
  }

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
        buildRemoteAttachCommand({ sessionId: sanitizedSessionId, windowIndex, windowId }),
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

  const writeInput = async (payload) => {
    if (copyModeActive) {
      copyModeActive = false
      try {
        await remoteCancelCopyMode(host, sanitizedSessionId, windowIndex, windowId)
        await sleep(50)
      } catch (error) {
        console.warn('Failed to leave remote tmux copy mode', safeErrorMessage(error))
      }
    }
    ptyProcess?.write(payload)
  }

  const scrollPane = async (lines) => {
    try {
      const scrolled = await remoteScrollPane(host, sanitizedSessionId, windowIndex, windowId, lines)
      copyModeActive = copyModeActive || scrolled
    } catch (error) {
      console.warn('Failed to scroll remote tmux pane', safeErrorMessage(error))
    }
  }

  ws.on('message', (raw) => {
    let incoming
    try {
      incoming = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (incoming.type === 'input' && typeof incoming.payload === 'string') {
      if (!monitorMode) {
        writeInput(incoming.payload)
      }
      return
    }
    if (incoming.type === 'scroll') {
      if (!monitorMode) {
        scrollPane(incoming.lines)
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
