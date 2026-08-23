import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createHttpServer } from '../src/http-server.js'

class FakeControl extends EventEmitter {
  health() { return { ok: true } }
  presets() { return [{ id: 'default' }] }
  listCachedThreads() { return [{ id: 'thread-1' }] }
  listApprovals() { return [] }
  snapshot() { return { threads: this.listCachedThreads() } }
  async createThread(input) { return { thread: { id: 'created', prompt: input.prompt } } }
}

test('serves health, thread listing, and controlled thread creation', async (t) => {
  const control = new FakeControl()
  const server = createHttpServer({ control, config: { maxBodyBytes: 4096 } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()

  const health = await fetch(`http://127.0.0.1:${port}/health`)
  assert.deepEqual(await health.json(), { ok: true })

  const threads = await fetch(`http://127.0.0.1:${port}/threads`)
  assert.deepEqual(await threads.json(), { threads: [{ id: 'thread-1' }], approvals: [] })

  const created = await fetch(`http://127.0.0.1:${port}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' }),
  })
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { thread: { id: 'created', prompt: 'hello' } })
})
