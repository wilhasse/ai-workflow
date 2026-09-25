import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createT3ThreadSearch, T3ThreadSearchInputError } from './t3-thread-search.js'

const hosts = [
  { id: 'vm10', name: 'Main Desktop', ssh: 'private-user@10.1.0.10', secret: 'hidden' },
  { id: 'vm9', name: 'Supersaber', ssh: 'private-user@10.1.0.9' },
]

const match = (overrides = {}) => ({
  state: 'active',
  title: 'Ticket follow-up',
  workspace: '/home/cslog/project',
  matchedAt: '2026-09-15T12:00:00.000Z',
  provider: 'codex',
  hitCount: 1,
  snippet: 'The matching prompt',
  t3ThreadId: 't3-id',
  codexThreadId: 'codex-id',
  route: '/environment-id/t3-id',
  ...overrides,
})

const envelope = (matches = []) => JSON.stringify({ schemaVersion: 1, matches })

const capability = (overrides = {}) => createT3ThreadSearch({
  loadCatalog: async () => ({ hosts }),
  runSsh: async () => ({ ok: true, stdout: envelope() }),
  now: () => new Date('2026-09-15T15:00:00.000Z'),
  ...overrides,
})

const assertInputError = async (promise, pattern) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof T3ThreadSearchInputError)
    assert.equal(error.statusCode, 400)
    assert.match(error.message, pattern)
    return true
  })
}

test('listHosts exposes only catalog IDs and names', async () => {
  assert.deepEqual(await capability().listHosts(), {
    hosts: [
      { id: 'vm10', name: 'Main Desktop' },
      { id: 'vm9', name: 'Supersaber' },
    ],
  })
})

test('search selects an exact host and passes hostile text as one literal argument', async () => {
  const calls = []
  const hostileText = "ticket '$(touch /tmp/nope)' ; echo pwned"
  const search = capability({
    scriptPath: 'capture',
    runSsh: async (...args) => {
      calls.push(args)
      return { ok: true, stdout: envelope([match()]) }
    },
  })

  const result = await search.search({ hostId: 'vm9', text: `  ${hostileText}  `, limit: 10 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'private-user@10.1.0.9')
  assert.equal(calls[0][2], 15000)
  assert.deepEqual(calls[0][3], { encoding: 'utf8', maxBuffer: 256 * 1024 })
  const argv = execFileSync('bash', [
    '-c',
    `capture() { printf '%s\\0' "$@"; }; ${calls[0][1]}`,
  ]).toString().split('\0').filter(Boolean)
  assert.deepEqual(argv, ['--json', '--limit', '10', '--', hostileText])
  assert.equal(result.results[0].hostId, 'vm9')
  assert.equal(result.results[0].hostName, 'Supersaber')
  assert.equal(result.results[0].status, 'ok')
  assert.equal(result.results[0].matches.length, 1)
})

test('search uses the fixed production script path by default', async () => {
  let remoteCommand = ''
  const search = capability({
    runSsh: async (_target, command) => {
      remoteCommand = command
      return { ok: true, stdout: envelope() }
    },
  })

  await search.search({ hostId: 'vm10', text: 'ticket' })
  assert.match(remoteCommand, /^'\/home\/cslog\/t3-find-thread' --json --limit 20 -- /)
})

test('search requires hostId and rejects unknown hosts', async () => {
  const search = capability()
  await assertInputError(search.search({ text: 'ticket' }), /hostId is required/)
  await assertInputError(search.search({ hostId: '', text: 'ticket' }), /hostId must not be empty/)
  await assertInputError(search.search({ hostId: 'vm404', text: 'ticket' }), /Unknown hostId/)
})

test('search validates text and limit bounds', async () => {
  const search = capability()
  await assertInputError(search.search({ hostId: null, text: '   ' }), /text must not be empty/)
  await assertInputError(search.search({ hostId: null, text: 'bad\0text' }), /unsupported character/)
  await assertInputError(search.search({ hostId: null, text: 'é'.repeat(1025) }), /2048 UTF-8 bytes/)
  for (const limit of [0, 51, 1.5, '20']) {
    await assertInputError(search.search({ hostId: null, text: 'ticket', limit }), /limit must be an integer/)
  }
})

test('all-host search starts concurrently and preserves catalog order', async () => {
  const resolvers = new Map()
  const started = []
  const search = capability({
    runSsh: (target) => new Promise((resolve) => {
      started.push(target)
      resolvers.set(target, resolve)
    }),
  })

  const pending = search.search({ hostId: null, text: 'ticket' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['private-user@10.1.0.10', 'private-user@10.1.0.9'])
  resolvers.get('private-user@10.1.0.9')({ ok: true, stdout: envelope([match({ t3ThreadId: 'vm9' })]) })
  resolvers.get('private-user@10.1.0.10')({ ok: true, stdout: envelope() })

  const result = await pending
  assert.deepEqual(result.results.map((entry) => entry.hostId), ['vm10', 'vm9'])
  assert.deepEqual(result.results.map((entry) => entry.hostName), ['Main Desktop', 'Supersaber'])
  assert.deepEqual(result.results.map((entry) => entry.status), ['no_match', 'ok'])
  assert.equal(result.searchedAt, '2026-09-15T15:00:00.000Z')
})

test('all-host search keeps partial failures and does not expose diagnostics', async () => {
  const catalogHosts = [
    ...hosts,
    { id: 'vm12', name: 'DB Server', ssh: null },
    { id: 'vm13', name: 'Offline', ssh: 'private-user@10.1.0.13' },
  ]
  const search = capability({
    loadCatalog: async () => ({ hosts: catalogHosts }),
    runSsh: async (target) => {
      if (target.endsWith('.10')) return { ok: true, stdout: envelope([match()]) }
      if (target.endsWith('.9')) return { ok: false, error: { code: 2, stderr: 'database path and secret' } }
      return { ok: false, error: { code: 255, stderr: 'private network details' } }
    },
  })

  const result = await search.search({ hostId: null, text: 'sensitive query' })
  assert.deepEqual(result.results.map((entry) => [entry.status, entry.reason]), [
    ['ok', undefined],
    ['unavailable', 'search_unavailable'],
    ['unavailable', 'not_configured'],
    ['unavailable', 'unreachable'],
  ])
  assert.deepEqual(result.results.map((entry) => entry.matches.length), [1, 0, 0, 0])
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /private-user|10\.1\.0|database path|secret|sensitive query/)
})

test('search classifies thrown and returned timeouts', async () => {
  for (const error of [{ killed: true }, { code: 'ETIMEDOUT' }, { signal: 'SIGTERM' }]) {
    const returned = capability({ runSsh: async () => ({ ok: false, error }) })
    assert.equal((await returned.search({ hostId: 'vm10', text: 'ticket' })).results[0].reason, 'timeout')

    const thrown = capability({ runSsh: async () => { throw error } })
    assert.equal((await thrown.search({ hostId: 'vm10', text: 'ticket' })).results[0].reason, 'timeout')
  }
})

test('search classifies output buffer overflow as an invalid response', async () => {
  const error = {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: 'private oversized output',
  }

  for (const runSsh of [
    async () => ({ ok: false, error }),
    async () => { throw error },
  ]) {
    const result = await capability({ runSsh }).search({ hostId: 'vm10', text: 'ticket' })
    assert.equal(result.results[0].status, 'unavailable')
    assert.equal(result.results[0].reason, 'invalid_response')
    assert.deepEqual(result.results[0].matches, [])
    assert.doesNotMatch(JSON.stringify(result), /private oversized output/)
  }
})

test('search rejects malformed, unsupported, oversized, and invalid match responses', async () => {
  const invalidPayloads = [
    'not json',
    JSON.stringify({ schemaVersion: 2, matches: [] }),
    JSON.stringify({ schemaVersion: 1, matches: 'nope' }),
    envelope([match({ hitCount: 0 })]),
    envelope([match({ state: 'deleted' })]),
    envelope([match({ route: 'environment/thread' })]),
    envelope([match(), match()]),
  ]

  for (const stdout of invalidPayloads) {
    const search = capability({ runSsh: async () => ({ ok: true, stdout }) })
    const result = await search.search({ hostId: 'vm10', text: 'ticket', limit: 1 })
    assert.equal(result.results[0].status, 'unavailable')
    assert.equal(result.results[0].reason, 'invalid_response')
  }

  const oversized = capability({
    maxOutputBytes: 10,
    runSsh: async () => ({ ok: true, stdout: envelope() }),
  })
  assert.equal(
    (await oversized.search({ hostId: 'vm10', text: 'ticket' })).results[0].reason,
    'invalid_response',
  )
})

test('search limits all-host fan-out', async () => {
  const search = capability({
    maxHosts: 1,
    loadCatalog: async () => ({ hosts }),
  })
  await assertInputError(search.search({ hostId: null, text: 'ticket' }), /at most 1 hosts/)
})

test('empty and unusable catalogs fail instead of reporting a successful zero-host search', async () => {
  for (const catalog of [{ hosts: [] }, { hosts: [null, {}, { id: '' }] }]) {
    const search = capability({ loadCatalog: async () => catalog })
    await assert.rejects(search.listHosts(), /no usable hosts/)
    await assert.rejects(search.search({ hostId: null, text: 'ticket' }), /no usable hosts/)
  }
})

test('search accepts null provider and Codex thread IDs', async () => {
  const search = capability({
    runSsh: async () => ({
      ok: true,
      stdout: envelope([match({ provider: null, codexThreadId: null })]),
    }),
  })

  const result = await search.search({ hostId: 'vm10', text: 'ticket' })
  assert.equal(result.results[0].status, 'ok')
  assert.equal(result.results[0].matches[0].provider, null)
  assert.equal(result.results[0].matches[0].codexThreadId, null)
})

test('search forwards only documented match fields', async () => {
  const search = capability({
    runSsh: async () => ({
      ok: true,
      stdout: envelope([match({ internalValue: 'private' })]),
    }),
  })

  const result = await search.search({ hostId: 'vm10', text: 'ticket' })
  assert.equal(result.results[0].matches[0].internalValue, undefined)
  assert.doesNotMatch(JSON.stringify(result), /private/)
})
