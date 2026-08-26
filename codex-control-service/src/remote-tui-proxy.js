import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'

const REMOTE_THREAD_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/fork',
])

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
  if (
    !connectionState.isCodexTui ||
    !REMOTE_THREAD_METHODS.has(message?.method) ||
    !Object.hasOwn(message.params || {}, 'runtimeWorkspaceRoots')
  ) {
    return data
  }

  const params = { ...message.params }
  delete params.runtimeWorkspaceRoots
  return JSON.stringify({ ...message, params })
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
            downstream.send(data, { binary: isBinary })
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
