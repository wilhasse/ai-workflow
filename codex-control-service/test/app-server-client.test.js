import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { AppServerClient } from '../src/app-server-client.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-app-server.js')

test('initializes app-server and routes responses and server requests', async (t) => {
  const client = new AppServerClient({
    bin: process.execPath,
    args: [fixture],
    requestTimeoutMs: 2000,
  })
  t.after(() => client.stop())

  await client.start()
  assert.equal(client.status.ready, true)
  assert.deepEqual(await client.request('echo', { value: 'ok' }), { value: 'ok' })

  const approvalPromise = once(client, 'serverRequest')
  await client.request('request-approval')
  const [approval] = await approvalPromise
  assert.deepEqual(
    { id: approval.id, method: approval.method, command: approval.params.command },
    {
      id: 900,
      method: 'item/commandExecution/requestApproval',
      command: 'pwd',
    },
  )
})

test('connects to a shared app-server websocket with bearer authentication', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-client-'))
  const tokenFile = path.join(tempDir, 'token')
  fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => {
    server.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  let authorization = ''
  server.on('connection', (socket, request) => {
    authorization = request.headers.authorization || ''
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'))
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }))
      } else if (message.method === 'echo') {
        socket.send(JSON.stringify({ id: message.id, result: message.params }))
      }
    })
  })
  const { port } = server.address()
  const client = new AppServerClient({
    url: `ws://127.0.0.1:${port}`,
    tokenFile,
    requestTimeoutMs: 2000,
  })
  t.after(() => client.stop())

  await client.start()

  assert.equal(authorization, 'Bearer test-token')
  assert.deepEqual(client.status, {
    ready: true,
    pid: null,
    transport: 'websocket',
    lastError: '',
  })
  assert.deepEqual(await client.request('echo', { value: 'shared' }), { value: 'shared' })
})
