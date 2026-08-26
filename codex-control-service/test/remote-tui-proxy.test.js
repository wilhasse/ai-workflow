import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import {
  createRemoteTuiProxy,
  rewriteRemoteTuiRequest,
  rewriteRemoteTuiResponse,
} from '../src/remote-tui-proxy.js'

const jsonMessage = (message) => Buffer.from(JSON.stringify(message))

test('rewrites only Codex TUI thread lifecycle workspace roots', () => {
  const state = { isCodexTui: false }
  const initialize = jsonMessage({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'codex-tui' } },
  })
  assert.equal(rewriteRemoteTuiRequest(initialize, false, state), initialize)

  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const rewritten = rewriteRemoteTuiRequest(jsonMessage({
      method,
      id: 2,
      params: {
        runtimeWorkspaceRoots: ['C:\\Users\\cslog\\workspace'],
        sandbox: 'readOnly',
      },
    }), false, state)
    assert.deepEqual(JSON.parse(rewritten), {
      method,
      id: 2,
      params: { sandbox: 'readOnly' },
    })
  }

  const turn = jsonMessage({
    method: 'turn/start',
    id: 3,
    params: { runtimeWorkspaceRoots: ['C:\\Users\\cslog\\workspace'] },
  })
  assert.equal(rewriteRemoteTuiRequest(turn, false, state), turn)
})

test('maps Linux response paths for Windows TUI clients and restores them on turns', () => {
  const state = { isCodexTui: false }
  rewriteRemoteTuiRequest(jsonMessage({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'codex-tui' } },
  }), false, state)
  rewriteRemoteTuiRequest(jsonMessage({
    method: 'thread/start',
    id: 2,
    params: { runtimeWorkspaceRoots: ['C:\\Users\\cslog\\workspace'] },
  }), false, state)

  const rewrittenResponse = rewriteRemoteTuiResponse(jsonMessage({
    id: 2,
    result: {
      thread: { cwd: '/home/cslog', path: '/home/cslog/.codex/thread.jsonl' },
      cwd: '/home/cslog',
      runtimeWorkspaceRoots: ['/home/cslog', '/srv/project'],
    },
  }), false, state)
  assert.deepEqual(JSON.parse(rewrittenResponse), {
    id: 2,
    result: {
      thread: {
        cwd: 'C:\\__codex_remote_posix__\\home\\cslog',
        path: 'C:\\__codex_remote_posix__\\home\\cslog\\.codex\\thread.jsonl',
      },
      cwd: 'C:\\__codex_remote_posix__\\home\\cslog',
      runtimeWorkspaceRoots: [
        'C:\\__codex_remote_posix__\\home\\cslog',
        'C:\\__codex_remote_posix__\\srv\\project',
      ],
    },
  })

  const rewrittenTurn = rewriteRemoteTuiRequest(jsonMessage({
    method: 'turn/start',
    id: 3,
    params: {
      cwd: 'C:\\__codex_remote_posix__\\home\\cslog',
      runtimeWorkspaceRoots: ['C:\\__codex_remote_posix__\\srv\\project'],
    },
  }), false, state)
  assert.deepEqual(JSON.parse(rewrittenTurn), {
    method: 'turn/start',
    id: 3,
    params: {
      cwd: '/home/cslog',
      runtimeWorkspaceRoots: ['/srv/project'],
    },
  })
})

test('preserves Linux response paths for non-Windows TUI clients', () => {
  const state = { isCodexTui: true }
  const response = jsonMessage({
    id: 2,
    result: { cwd: '/home/cslog', runtimeWorkspaceRoots: ['/home/cslog'] },
  })

  assert.equal(rewriteRemoteTuiResponse(response, false, state), response)
})

test('preserves workspace roots for non-TUI app-server clients', () => {
  const state = { isCodexTui: false }
  rewriteRemoteTuiRequest(jsonMessage({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'custom-client' } },
  }), false, state)
  const start = jsonMessage({
    method: 'thread/start',
    id: 2,
    params: { runtimeWorkspaceRoots: ['/srv/workspace'] },
  })

  assert.equal(rewriteRemoteTuiRequest(start, false, state), start)
})

test('forwards authentication and normalized TUI requests to the app server', async (context) => {
  const upstreamHttp = http.createServer()
  const upstreamWebSocket = new WebSocketServer({ noServer: true })
  let authorization
  const received = []
  upstreamHttp.on('upgrade', (request, socket, head) => {
    authorization = request.headers.authorization
    upstreamWebSocket.handleUpgrade(request, socket, head, (webSocket) => {
      upstreamWebSocket.emit('connection', webSocket, request)
    })
  })
  upstreamWebSocket.on('connection', (webSocket) => {
    webSocket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'))
      received.push(message)
      webSocket.send(JSON.stringify({
        id: message.id,
        result: message.method === 'thread/start'
          ? { cwd: '/home/cslog', runtimeWorkspaceRoots: ['/home/cslog'] }
          : {},
      }))
    })
  })
  upstreamHttp.listen(0, '127.0.0.1')
  await once(upstreamHttp, 'listening')
  const upstreamAddress = upstreamHttp.address()

  const proxy = createRemoteTuiProxy({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
  })
  const proxyAddress = await proxy.listen()
  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}`, {
    headers: { Authorization: 'Bearer test-token' },
  })
  await once(client, 'open')

  context.after(async () => {
    client.terminate()
    await proxy.close()
    for (const webSocket of upstreamWebSocket.clients) webSocket.terminate()
    await new Promise((resolve) => upstreamHttp.close(resolve))
  })

  client.send(JSON.stringify({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'codex-tui' } },
  }))
  await once(client, 'message')
  client.send(JSON.stringify({
    method: 'thread/start',
    id: 2,
    params: {
      runtimeWorkspaceRoots: ['C:\\Users\\cslog\\workspace'],
      ephemeral: true,
    },
  }))
  const [threadStartResponse] = await once(client, 'message')

  assert.equal(authorization, 'Bearer test-token')
  assert.deepEqual(received, [
    {
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'codex-tui' } },
    },
    {
      method: 'thread/start',
      id: 2,
      params: { ephemeral: true },
    },
  ])
  assert.deepEqual(JSON.parse(threadStartResponse.toString('utf8')), {
    id: 2,
    result: {
      cwd: 'C:\\__codex_remote_posix__\\home\\cslog',
      runtimeWorkspaceRoots: ['C:\\__codex_remote_posix__\\home\\cslog'],
    },
  })

  client.close()
  await once(client, 'close')
  assert.ok(proxy.address())
})

test('does not upgrade a client rejected by app-server authentication', async (context) => {
  const upstreamHttp = http.createServer()
  upstreamHttp.on('upgrade', (_request, socket) => {
    socket.end(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n',
    )
  })
  upstreamHttp.listen(0, '127.0.0.1')
  await once(upstreamHttp, 'listening')
  const upstreamAddress = upstreamHttp.address()
  const proxy = createRemoteTuiProxy({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
  })
  const proxyAddress = await proxy.listen()
  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}`)
  client.on('error', () => {})

  context.after(async () => {
    client.terminate()
    await proxy.close()
    await new Promise((resolve) => upstreamHttp.close(resolve))
  })

  const [_request, response] = await once(client, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  response.resume()
})
