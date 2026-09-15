const DEFAULT_LIMIT = 20
const MAX_TEXT_BYTES = 2048
const SCRIPT_SCHEMA_VERSION = 1
export class T3ThreadSearchInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'T3ThreadSearchInputError'
    this.statusCode = 400
  }
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

const publicHost = (host) => ({
  id: String(host.id),
  name: String(host.name || host.id),
})

const validateRequest = (rawRequest) => {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new T3ThreadSearchInputError('Request body must be a JSON object')
  }
  if (!Object.prototype.hasOwnProperty.call(rawRequest, 'hostId')) {
    throw new T3ThreadSearchInputError('hostId is required')
  }
  if (rawRequest.hostId !== null && typeof rawRequest.hostId !== 'string') {
    throw new T3ThreadSearchInputError('hostId must be a string or null')
  }

  const hostId = rawRequest.hostId === null ? null : rawRequest.hostId.trim()
  if (rawRequest.hostId !== null && !hostId) {
    throw new T3ThreadSearchInputError('hostId must not be empty')
  }
  if (typeof rawRequest.text !== 'string') {
    throw new T3ThreadSearchInputError('text is required')
  }

  const text = rawRequest.text.trim()
  if (!text) {
    throw new T3ThreadSearchInputError('text must not be empty')
  }
  if (text.includes('\0')) {
    throw new T3ThreadSearchInputError('text contains an unsupported character')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new T3ThreadSearchInputError(`text must be at most ${MAX_TEXT_BYTES} UTF-8 bytes`)
  }

  const limit = rawRequest.limit === undefined ? DEFAULT_LIMIT : rawRequest.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new T3ThreadSearchInputError('limit must be an integer from 1 to 50')
  }

  return { hostId, text, limit }
}

const validatedCatalogHosts = (catalog) => {
  if (!catalog || !Array.isArray(catalog.hosts)) {
    throw new Error('Workspace catalog has no hosts')
  }
  const hosts = catalog.hosts.filter((host) => host && typeof host.id === 'string' && host.id)
  if (hosts.length === 0) {
    throw new Error('Workspace catalog has no usable hosts')
  }
  return hosts
}

const isString = (value) => typeof value === 'string'
const isNullableString = (value) => value === null || isString(value)

const validateMatch = (match) => {
  if (!match || typeof match !== 'object' || Array.isArray(match)) return false
  if (match.state !== 'active' && match.state !== 'archived') return false
  if (!isString(match.title) || !isString(match.workspace) || !isString(match.matchedAt)) return false
  if (!isNullableString(match.provider) || !isString(match.snippet)) return false
  if (!isString(match.t3ThreadId) || !match.t3ThreadId) return false
  if (!isNullableString(match.codexThreadId) || !isString(match.route) || !match.route.startsWith('/')) return false
  return Number.isInteger(match.hitCount) && match.hitCount >= 1
}

const normalizeMatch = (match) => ({
  state: match.state,
  title: match.title,
  workspace: match.workspace,
  matchedAt: match.matchedAt,
  provider: match.provider,
  hitCount: match.hitCount,
  snippet: match.snippet,
  t3ThreadId: match.t3ThreadId,
  codexThreadId: match.codexThreadId,
  route: match.route,
})

const parseScriptResponse = (stdout, limit, maxOutputBytes) => {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
    return null
  }

  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    return null
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.schemaVersion !== SCRIPT_SCHEMA_VERSION || !Array.isArray(payload.matches)) return null
  if (payload.matches.length > limit || !payload.matches.every(validateMatch)) return null
  return payload.matches.map(normalizeMatch)
}

const unavailableReason = (error) => {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'invalid_response'
  }
  if (error?.killed || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') {
    return 'timeout'
  }
  if (error?.code === 255) {
    return 'unreachable'
  }
  return 'search_unavailable'
}

const unavailable = (host, reason) => ({
  hostId: String(host.id),
  hostName: String(host.name || host.id),
  status: 'unavailable',
  matches: [],
  reason,
})

const available = (host, status, matches) => ({
  hostId: String(host.id),
  hostName: String(host.name || host.id),
  status,
  matches,
})

export const createT3ThreadSearch = ({
  loadCatalog,
  runSsh,
  now = () => new Date(),
  scriptPath = '/home/cslog/t3-find-thread',
  timeoutMs = 15000,
  maxOutputBytes = 256 * 1024,
  maxHosts = 20,
}) => {
  if (typeof loadCatalog !== 'function' || typeof runSsh !== 'function') {
    throw new TypeError('loadCatalog and runSsh are required')
  }

  const listHosts = async () => {
    const hosts = validatedCatalogHosts(await loadCatalog())
    return { hosts: hosts.map(publicHost) }
  }

  const searchHost = async (host, request) => {
    if (!host.ssh) {
      return unavailable(host, 'not_configured')
    }

    const remoteCommand = [
      shellQuote(scriptPath),
      '--json',
      '--limit',
      String(request.limit),
      '--',
      shellQuote(request.text),
    ].join(' ')

    let response
    try {
      response = await runSsh(host.ssh, remoteCommand, timeoutMs, {
        encoding: 'utf8',
        maxBuffer: maxOutputBytes,
      })
    } catch (error) {
      return unavailable(host, unavailableReason(error))
    }

    if (!response?.ok) {
      return unavailable(host, unavailableReason(response?.error))
    }

    const matches = parseScriptResponse(response.stdout, request.limit, maxOutputBytes)
    if (!matches) {
      return unavailable(host, 'invalid_response')
    }
    if (matches.length === 0) {
      return available(host, 'no_match', [])
    }
    return available(host, 'ok', matches)
  }

  const search = async (rawRequest) => {
    const request = validateRequest(rawRequest)
    const catalogHosts = validatedCatalogHosts(await loadCatalog())
    const selectedHosts = request.hostId === null
      ? catalogHosts
      : catalogHosts.filter((host) => host.id === request.hostId)

    if (request.hostId !== null && selectedHosts.length === 0) {
      throw new T3ThreadSearchInputError('Unknown hostId')
    }
    if (selectedHosts.length > maxHosts) {
      throw new T3ThreadSearchInputError(`A search may include at most ${maxHosts} hosts`)
    }

    const results = await Promise.all(selectedHosts.map((host) => searchHost(host, request)))
    const searchedAtValue = now()
    const searchedAt = searchedAtValue instanceof Date
      ? searchedAtValue.toISOString()
      : new Date(searchedAtValue).toISOString()
    return { searchedAt, results }
  }

  return { listHosts, search }
}
