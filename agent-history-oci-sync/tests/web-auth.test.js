import assert from 'node:assert/strict'
import http from 'node:http'
import { test, before } from 'node:test'
import { once } from 'node:events'
import { createServer } from '../src/server.js'
import { createBrowserAuth, hashPassword } from '../src/auth.js'

const password = 'a-test-password-that-is-long-enough'
const origin = 'https://msg.example.test'
const token = 'a-machine-token-that-is-long-enough'
let passwordHash
before(async () => { passwordHash = await hashPassword(password) })

async function fixture(t, overrides = {}) {
  const calls = []
  const settings = { apiToken: token, history: { username: 'reader', passwordHash, origin } }
  const route = async (method, url, body) => {
    calls.push({ method, url, body })
    if (url === '/health') return { status: 200, body: { ok: true, mysql: 'private host details' } }
    if (url === '/failure') throw new Error('SQL password=do-not-expose')
    return { status: 200, body: { ok: true, data: { method, url, body } } }
  }
  const server = createServer({ route, settings, ...overrides })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => { server.closeAllConnections(); server.close() })
  const request = (path, options) => fetch(`${base}${path}`, options)
  const login = (body = { username: 'reader', password }, headers = {}) => request('/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { server, base, request, login, calls, settings }
}

function cookie(res) { return res.headers.get('set-cookie').split(';')[0] }

test('serves login assets and minimal health without granting API access', async t => {
  const f = await fixture(t)
  const page = await f.request('/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Open your archive/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('access-control-allow-origin'), null)
  assert.equal((await f.request('/app.js')).status, 200)
  assert.deepEqual(await (await f.request('/health')).json(), { ok: true })
  for (const path of ['/sessions', '/api/agent-history/sessions', '/api/agent-history/stats', '/ingest/messages', '/%2e%2e/config.js', '/public/../config.js']) {
    assert.equal((await f.request(path)).status, 401, path)
  }
  assert.equal(f.calls.length, 1)
})

test('login cookie reads only prefixed allowlisted GETs, while bearer retains machine API', async t => {
  const f = await fixture(t)
  const wrong = await f.login({ username: 'reader', password: 'wrong' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.headers.get('set-cookie'), null)
  const signed = await f.login()
  assert.equal(signed.status, 200)
  const session = cookie(signed)
  assert.match(signed.headers.get('set-cookie'), /^__Host-history=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/)
  const headers = { Cookie: session }
  assert.equal((await f.request('/auth/session', { headers })).status, 200)
  const read = await f.request('/api/agent-history/sessions/test/messages?vm_id=host-a&limit=100', { headers })
  assert.equal(read.status, 200)
  assert.equal((await read.json()).data.url, '/sessions/test/messages?vm_id=host-a&limit=100')
  assert.equal((await f.request('/sessions', { headers })).status, 401)
  assert.equal((await f.request('/ingest/messages', { method: 'POST', headers, body: '{}' })).status, 401)
  assert.equal((await f.request('/api/agent-history/ingest/messages', { method: 'POST', headers, body: '{}' })).status, 403)
  assert.equal((await f.request('/api/agent-history/ingest/messages', { headers })).status, 403)
  assert.equal((await f.request('/api/agent-history/sessions', { method: 'POST', headers, body: '{}' })).status, 403)
  assert.equal((await f.request('/api/agent-history/secrets', { headers })).status, 403)
  const write = await f.request('/ingest/messages', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [{ message_id: 'one' }] }) })
  assert.equal(write.status, 200)
  assert.deepEqual((await write.json()).data.body, { records: [{ message_id: 'one' }] })
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
})

test('enforces same origin and JSON on auth writes, revokes on logout and rotates on login', async t => {
  const f = await fixture(t)
  assert.equal((await f.login(undefined, { Origin: 'https://evil.test' })).status, 403)
  assert.equal((await f.login(undefined, { Origin: 'null' })).status, 403)
  assert.equal((await f.login(undefined, { 'Content-Type': 'text/plain' })).status, 403)
  assert.equal((await f.request('/auth/login', { method: 'POST', body: '{}' })).status, 403)
  const first = cookie(await f.login())
  const second = cookie(await f.login(undefined, { Cookie: first }))
  assert.notEqual(first, second)
  assert.equal((await f.request('/auth/session', { headers: { Cookie: first } })).status, 401)
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: second, Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
  assert.equal((await f.request('/auth/session', { headers: { Cookie: second } })).status, 200)
  const loggedOut = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: second, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(loggedOut.status, 200)
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await f.request('/api/agent-history/sessions', { headers: { Cookie: second } })).status, 401)
})

test('rejects tampered cookies and expires sessions at the configured deadline', async t => {
  let time = 1000
  const browserAuth = createBrowserAuth({ username: 'reader', passwordHash, origin }, { now: () => time, ttlMs: 60_000 })
  const f = await fixture(t, { browserAuth })
  const signed = cookie(await f.login())
  assert.equal((await f.request('/auth/session', { headers: { Cookie: signed } })).status, 200)
  assert.equal((await f.request('/auth/session', { headers: { Cookie: signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a') } })).status, 401)
  time += 60_000
  assert.equal((await f.request('/auth/session', { headers: { Cookie: signed } })).status, 401)
})

test('bounds auth bodies and validates malformed payloads without disclosing internal errors', async t => {
  const f = await fixture(t, { maxBodyBytes: 32 })
  assert.equal((await f.login({ username: 'reader', password: 'x'.repeat(5000) })).status, 413)
  assert.equal((await f.login({ username: 'reader', password: 'x'.repeat(1025) })).status, 400)
  assert.equal((await f.login(null)).status, 400)
  assert.equal((await f.request('/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await f.request('/ingest/messages', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x'.repeat(33) })).status, 413)
  const fail = await f.request('/failure', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(fail.status, 500)
  assert.doesNotMatch(await fail.text(), /SQL|password|do-not-expose/)
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/ingest/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.write('x'.repeat(20))
    req.end('x'.repeat(20))
  })
  assert.equal(chunked, 413)
})

test('throttles password attempts despite spoofed forwarded client IPs', async t => {
  const f = await fixture(t)
  for (let n = 0; n < 10; n++) {
    const res = await f.login({ username: 'reader', password: 'bad' }, { 'X-Forwarded-For': `203.0.113.${n}` })
    assert.equal(res.status, 401)
  }
  const limited = await f.login()
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '300')
})

test('bounds concurrent password checks', async t => {
  const f = await fixture(t)
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.login({ username: 'reader', password: 'bad' })))
  assert.ok(responses.some(res => res.status === 429))
  assert.ok(responses.every(res => [401, 429].includes(res.status)))
})

test('fails closed on missing or invalid credentials and permits explicitly disabled browser', async t => {
  const route = async () => ({ status: 200, body: { ok: true } })
  assert.throws(() => createServer({ route, settings: { apiToken: '' } }), /API_TOKEN/)
  for (const history of [
    { username: 'reader', passwordHash, origin: 'http://example.test' },
    { username: 'reader', passwordHash, origin: `${origin}/` },
    { username: 'reader', passwordHash: 'wrong', origin },
    { username: '', passwordHash, origin },
  ]) assert.throws(() => createServer({ route, settings: { apiToken: token, history } }), /HISTORY/)
  const f = await fixture(t, { settings: { apiToken: token, history: {} } })
  assert.equal((await f.request('/')).status, 401)
  assert.equal((await f.request('/auth/login')).status, 404)
  assert.equal((await f.request('/sessions', { headers: { Authorization: `Bearer ${token}` } })).status, 200)
})
