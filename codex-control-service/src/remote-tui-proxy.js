import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'

const REMOTE_THREAD_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/fork',
])

const REMOTE_POSIX_PATH_PREFIX = 'C:\\__codex_remote_posix__'

const SCALAR_PATH_FIELDS = new Set([
  'composerIcon',
  'cwd',
  'destinationPath',
  'filePath',
  'iconLarge',
  'iconSmall',
  'installedRoot',
  'localPluginPath',
  'logo',
  'logoDark',
  'marketplacePath',
  'path',
  'pluginPath',
  'sourcePath',
])

const ARRAY_PATH_FIELDS = new Set([
  'changedPaths',
  'cwds',
  'extraRoots',
  'files',
  'runtimeWorkspaceRoots',
  'screenshots',
  'upgradedRoots',
])

const isWindowsAbsolutePath = (value) => (
  typeof value === 'string' && (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  )
)

const remotePosixPathToWindows = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/')) return value
  return `${REMOTE_POSIX_PATH_PREFIX}${value.replaceAll('/', '\\')}`
}

const remoteWindowsPathToPosix = (value) => {
  if (typeof value !== 'string') return value
  const prefix = value.slice(0, REMOTE_POSIX_PATH_PREFIX.length)
  if (prefix.toLowerCase() !== REMOTE_POSIX_PATH_PREFIX.toLowerCase()) return value
  const suffix = value.slice(REMOTE_POSIX_PATH_PREFIX.length)
  if (suffix !== '' && !suffix.startsWith('\\') && !suffix.startsWith('/')) return value
  const normalized = suffix.replaceAll('\\', '/')
  return normalized === '' ? '/' : normalized
}

const rewritePathFields = (value, rewritePath) => {
  if (Array.isArray(value)) {
    let changed = false
    const rewritten = value.map((item) => {
      const result = rewritePathFields(item, rewritePath)
      changed ||= result.changed
      return result.value
    })
    return { value: changed ? rewritten : value, changed }
  }
  if (!value || typeof value !== 'object') return { value, changed: false }

  let changed = false
  const rewritten = { ...value }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (SCALAR_PATH_FIELDS.has(key) && typeof fieldValue === 'string') {
      const nextValue = rewritePath(fieldValue)
      if (nextValue !== fieldValue) {
        rewritten[key] = nextValue
        changed = true
      }
      continue
    }
    if (ARRAY_PATH_FIELDS.has(key) && Array.isArray(fieldValue)) {
      const nextValue = fieldValue.map((item) => (
        typeof item === 'string' ? rewritePath(item) : item
      ))
      if (nextValue.some((item, index) => item !== fieldValue[index])) {
        rewritten[key] = nextValue
        changed = true
      }
      continue
    }
    const nested = rewritePathFields(fieldValue, rewritePath)
    if (nested.changed) {
      rewritten[key] = nested.value
      changed = true
    }
  }
  return { value: changed ? rewritten : value, changed }
}

const requestUsesWindowsPaths = (message) => {
  let usesWindowsPaths = false
  rewritePathFields(message, (value) => {
    usesWindowsPaths ||= isWindowsAbsolutePath(value)
    return value
  })
  return usesWindowsPaths
}

const sendUpgradeError = (socket, statusCode, statusText) => {
  if (socket.destroyed) return
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n\r\n',
  )
}

const closePeer = (peer, code, reason) => {
  if (peer.readyState !== WebSocket.OPEN) return
  if (code === 1005) {
    peer.close()
    return
  }
  if (code === 1006) {
    peer.terminate()
    return
  }
  const isProtocolCode = code >= 1000 && code <= 1014 && code !== 1004
  const isApplicationCode = code >= 3000 && code <= 4999
  peer.close(isProtocolCode || isApplicationCode ? code : 1011, reason)
}

export const rewriteRemoteTuiRequest = (data, isBinary, connectionState) => {
  if (isBinary) return data

  let message
  try {
    message = JSON.parse(data.toString('utf8'))
  } catch {
    return data
  }

  if (message?.method === 'initialize') {
    connectionState.isCodexTui = message.params?.clientInfo?.name === 'codex-tui'
    return data
  }
  if (!connectionState.isCodexTui) return data

  if (!connectionState.clientPathStyle && requestUsesWindowsPaths(message.params)) {
    connectionState.clientPathStyle = 'windows'
  }

  const rewrittenMessage = rewritePathFields(message, remoteWindowsPathToPosix)
  let rewritten = rewrittenMessage.value
  let changed = rewrittenMessage.changed

  if (
    REMOTE_THREAD_METHODS.has(message?.method) &&
    Object.hasOwn(rewritten.params || {}, 'runtimeWorkspaceRoots')
  ) {
    const params = { ...rewritten.params }
    delete params.runtimeWorkspaceRoots
    rewritten = { ...rewritten, params }
    changed = true
  }

  return changed ? JSON.stringify(rewritten) : data
}

export const rewriteRemoteTuiResponse = (data, isBinary, connectionState) => {
  if (isBinary || !connectionState.isCodexTui || connectionState.clientPathStyle !== 'windows') {
    return data
  }

  let message
  try {
    message = JSON.parse(data.toString('utf8'))
  } catch {
    return data
  }

  const rewritten = rewritePathFields(message, remotePosixPathToWindows)
  return rewritten.changed ? JSON.stringify(rewritten.value) : data
}

export const createRemoteTuiProxy = ({
  host = '127.0.0.1',
  port = 4502,
  upstreamUrl,
}) => {
  if (!upstreamUrl) throw new Error('upstreamUrl is required')

  const upstreamSockets = new Set()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const server = http.createServer((request, response) => {
    if (request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('healthy\n')
      return
    }
    response.writeHead(404)
    response.end()
  })

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    if (pathname !== '/') {
      sendUpgradeError(socket, 404, 'Not Found')
      return
    }

    const headers = request.headers.authorization
      ? { Authorization: request.headers.authorization }
      : {}
    const upstream = new WebSocket(upstreamUrl, { headers })
    upstreamSockets.add(upstream)
    let upgraded = false

    const rejectUpgrade = (statusCode, statusText) => {
      if (upgraded) return
      upgraded = true
      upstream.terminate()
      sendUpgradeError(socket, statusCode, statusText)
    }

    upstream.once('unexpected-response', (_request, response) => {
      response.resume()
      const statusCode = response.statusCode === 401 ? 401 : 502
      rejectUpgrade(statusCode, statusCode === 401 ? 'Unauthorized' : 'Bad Gateway')
    })
    upstream.once('error', () => rejectUpgrade(502, 'Bad Gateway'))
    upstream.once('close', () => {
      upstreamSockets.delete(upstream)
      if (!upgraded) rejectUpgrade(502, 'Bad Gateway')
    })
    upstream.once('open', () => {
      if (upgraded) return
      upgraded = true
      webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
        const connectionState = { isCodexTui: false }

        downstream.on('message', (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return
          const payload = rewriteRemoteTuiRequest(data, isBinary, connectionState)
          upstream.send(payload, { binary: isBinary })
        })
        upstream.on('message', (data, isBinary) => {
          if (downstream.readyState === WebSocket.OPEN) {
            const payload = rewriteRemoteTuiResponse(data, isBinary, connectionState)
            downstream.send(payload, { binary: isBinary })
          }
        })
        downstream.on('close', (code, reason) => closePeer(upstream, code, reason))
        upstream.on('close', (code, reason) => closePeer(downstream, code, reason))
        downstream.on('error', () => upstream.terminate())
        upstream.on('error', () => downstream.terminate())
      })
    })
  })

  return {
    address: () => server.address(),
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve(server.address())
      })
    }),
    close: async () => {
      for (const client of webSocketServer.clients) client.terminate()
      for (const upstream of upstreamSockets) upstream.terminate()
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}
