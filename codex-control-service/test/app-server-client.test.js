import assert from 'node:assert/strict'
import { once } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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
