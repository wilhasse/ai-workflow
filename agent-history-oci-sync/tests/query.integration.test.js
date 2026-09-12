import assert from 'node:assert/strict'
import { test } from 'node:test'
import { route } from '../src/api/routes.js'
import { ensureSchema } from '../src/db/schema.js'
import { getPool } from '../src/db/connection.js'
import * as queries from '../src/db/queries.js'

// Run only against a disposable database named cslog166_query_test.
const enabled = process.env.HISTORY_QUERY_TEST === '1' && process.env.MYSQL_DATABASE === 'cslog166_query_test'

test('read API rejects invalid inputs before accessing the database', async () => {
  for (const path of ['/sessions?grouped=yes', '/sessions/id/children?limit=0', '/sessions?limit=0', '/sessions?limit=100000', '/sessions?offset=-1', '/sessions?from=2026-02-30', '/sessions?from=2026-09-12&to=2026-01-01', '/sessions/id/messages?dialog=yes', '/sessions/id/handoff?tail=201', '/sessions/id/messages?vm_id=', '/search?q=%00']) {
    assert.equal((await route('GET', path)).status, 400, path)
  }
})

test('real MySQL preserves host isolation, pagination, activity and indexed search', { skip: !enabled }, async () => {
  const pool = getPool()
  try {
    await ensureSchema()
    await ensureSchema() // Migration is safe to replay.
    for (const table of ['agent_messages', 'agent_sessions', 'session_summaries']) await pool.query(`DELETE FROM ${table}`)
    await queries.upsertSessions([
      { session_id: 'shared', vm_id: 'host-a', source: 'codex', started_at: '2026-01-01', display_text: null },
      { session_id: 'shared', vm_id: 'host-a', source: 'codex', started_at: '2026-01-02', display_text: 'Latest A' },
      { session_id: 'shared', vm_id: 'host-b', source: 'codex', started_at: '2026-06-01', display_text: 'Host B' },
      { session_id: 'newer', vm_id: 'host-a', source: 'codex', started_at: '2026-08-01', display_text: 'Newer' },
    ])
    const record = (id, host, seq, role, text, ts = '2026-09-12 10:00:00') => ({ message_id: id, session_id: 'shared', vm_id: host, timestamp: ts, source: 'codex', seq_num: seq, role, content_text: text })
    const messages = [
      record('a1', 'host-a', 1, 'user', 'uniqueneedle first prompt'),
      record('a2', 'host-a', 2, 'tool', 'tool secret'),
      record('a3', 'host-a', 3, 'assistant', 'uniqueneedle answer'),
      record('a4', 'host-a', 4, 'user', 'final question'),
      record('b1', 'host-b', 1, 'user', 'uniqueneedle host B secret', '2026-06-02 00:00:00'),
    ]
    await queries.upsertMessages(messages)
    await queries.upsertMessages(messages)
    await queries.upsertSummary({ session_id: 'shared', vm_id: 'host-a', summary: 'summary A', model: 'test', msg_count: 3, last_message_ts: '2026-09-12' })
    await queries.upsertSummary({ session_id: 'shared', vm_id: 'host-b', summary: 'summary B', model: 'test', msg_count: 1, last_message_ts: '2026-06-02' })

    for (const suffix of ['', '/messages', '/handoff']) assert.equal((await route('GET', `/sessions/shared${suffix}`)).status, 400)
    const session = await route('GET', '/sessions/shared?vm_id=host-a')
    assert.equal(session.body.data.summary, 'summary A')
    assert.equal(session.body.data.display_text, 'Latest A')
    assert.equal(session.body.data.message_count, 4)
    const first = (await route('GET', '/sessions/shared/messages?vm_id=host-a&dialog=1&limit=2')).body.data
    const second = (await route('GET', '/sessions/shared/messages?vm_id=host-a&dialog=1&limit=2&offset=2')).body.data
    assert.deepEqual([...first, ...second].map(m => m.message_id), ['a1', 'a3', 'a4'])
    assert.equal((await route('GET', '/sessions/shared/messages?vm_id=host-a&dialog=0')).body.data.length, 4)
    const handoff = (await route('GET', '/sessions/shared/handoff?vm_id=host-a&tail=1')).body.data.markdown
    assert.match(handoff, /final question/)
    assert.match(handoff, /summary A/)
    assert.doesNotMatch(handoff, /summary B|host B secret|tool secret|first prompt/)
    assert.equal((await route('GET', '/sessions/shared/handoff?vm_id=missing')).status, 404)

    const sessions = (await route('GET', '/sessions?limit=10')).body.data
    assert.equal(sessions.filter(s => s.session_id === 'shared' && s.vm_id === 'host-a').length, 1)
    assert.equal(sessions[0].session_id, 'shared')
    assert.equal(sessions[0].vm_id, 'host-a')
    // Replaying old session metadata must not push a resumed conversation backwards.
    await queries.upsertSessions([{ session_id: 'shared', vm_id: 'host-a', started_at: '2026-01-02', source: 'codex' }])
    assert.equal((await route('GET', '/sessions?limit=1')).body.data[0].last_activity, '2026-09-12 10:00:00')
    const hits = (await route('GET', '/search?q=uniqueneedle&vm_id=host-a&dialog=1&limit=10')).body.data
    assert.deepEqual(hits.map(h => h.message_id).sort(), ['a1', 'a3'])
    const [[plan]] = await pool.query('EXPLAIN FORMAT=JSON SELECT message_id FROM agent_messages WHERE MATCH(content_text) AGAINST (? IN NATURAL LANGUAGE MODE)', ['uniqueneedle'])
    assert.match(JSON.stringify(plan), /fulltext/i)
    // The same message may be archived on multiple hosts; ties must paginate by
    // the complete identity rather than depending on the fulltext engine's order.
    await queries.upsertMessages(['host-a', 'host-b'].map(vm_id => ({
      message_id: 'identical-id', session_id: 'shared', vm_id, source: 'codex',
      timestamp: '2026-09-12 12:00:00', role: 'user', content_text: 'paginationtieneedle', seq_num: 10,
    })))
    const tieFirst = (await route('GET', '/search?q=paginationtieneedle&limit=1')).body.data
    const tieSecond = (await route('GET', '/search?q=paginationtieneedle&limit=1&offset=1')).body.data
    assert.deepEqual([...tieFirst, ...tieSecond].map(row => row.vm_id), ['host-a', 'host-b'])


    await queries.upsertMessages([{ message_id: 'orphan1', session_id: 'orphan', vm_id: 'host-a', source: 'codex', timestamp: '2026-09-13', role: 'user', content_text: 'Orphan title', seq_num: 1 }])
    const orphan = (await route('GET', '/sessions/orphan')).body.data
    assert.equal(orphan.title, 'Orphan title')
    assert.equal(orphan.message_count, 1)
    assert.equal((await route('GET', '/sessions/orphan/handoff')).status, 200)
    await queries.upsertSessions([{ session_id: 'orphan', vm_id: 'host-a', source: 'codex', started_at: '2026-01-01', display_text: 'Authoritative old session title' }])
    assert.equal((await route('GET', '/sessions/orphan')).body.data.title, 'Authoritative old session title')
    assert.equal((await route('GET', '/sessions/orphan')).body.data.last_activity, '2026-09-13 00:00:00')
    assert.equal((await route('GET', '/sessions?limit=100')).body.data.filter(s => s.session_id === 'orphan').length, 1)

    await queries.upsertSessions([{ session_id: 'injected', vm_id: 'host-a', source: 'codex', started_at: '2026-09-01', display_text: '# AGENTS.md instructions for /work' }])
    await queries.upsertMessages([
      { message_id: 'inject1', session_id: 'injected', vm_id: 'host-a', source: 'codex', timestamp: '2026-09-01', role: 'user', content_text: '  <environment_context>private scaffolding</environment_context>', seq_num: 1 },
      { message_id: 'inject2', session_id: 'injected', vm_id: 'host-a', source: 'codex', timestamp: '2026-09-01', role: 'user', content_text: 'Fix the real user problem', seq_num: 2 },
    ])
    assert.equal((await route('GET', '/sessions/injected')).body.data.title, 'Fix the real user problem')
    assert.equal((await route('GET', '/sessions?limit=100')).body.data.find(s => s.session_id === 'injected').title, 'Fix the real user problem')

    for (const whitespace of ['\n\n', '\t', '\r\n \t']) {
      await queries.upsertMessages([
        { message_id: 'inject1', session_id: 'injected', vm_id: 'host-a', source: 'codex', timestamp: '2026-09-01', role: 'user', content_text: `${whitespace}<environment_context>private scaffolding</environment_context>`, seq_num: 1 },
      ])
      assert.equal((await route('GET', '/sessions/injected')).body.data.title, 'Fix the real user problem', JSON.stringify(whitespace))
      assert.equal((await route('GET', '/sessions?limit=100')).body.data.find(s => s.session_id === 'injected').title, 'Fix the real user problem', JSON.stringify(whitespace))
    }


    // Helpers inherit titles, but grouping follows metadata and keeps root pagination.
    for (const table of ['agent_messages', 'agent_sessions', 'session_summaries']) await pool.query(`DELETE FROM ${table}`)
    const makeSession = (session_id, parent, extra = {}) => ({
      session_id, vm_id: 'host-a', source: 'codex', project: '/group',
      started_at: '2026-09-01', last_activity: '2026-09-12', display_text: 'Inherited title',
      session_meta: parent === undefined ? {} : { source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, agent_path: `/root/${session_id}`, agent_nickname: `Agent ${session_id}` },
      ...extra,
    })
    await queries.upsertSessions([
      makeSession('parent'), ...Array.from({ length: 5 }, (_, i) => makeSession(`helper-${i}`, 'parent')),
      makeSession('nested', 'helper-0'), makeSession('orphan-helper', 'absent'),
      makeSession('self-parent', 'self-parent'), makeSession('cycle-a', 'cycle-b'), makeSession('cycle-b', 'cycle-a'),
      makeSession('cycle-child', 'cycle-a'), makeSession('cross-host', 'parent', { vm_id: 'host-b' }),
      makeSession('malformed'), makeSession('invalid-parent', 123), makeSession('root-two'),
      makeSession('versioned', undefined, { started_at: '2026-08-01', source: 'claude' }),
      makeSession('versioned', 'parent', { started_at: '2026-09-01' }),
    ])
    await pool.query("UPDATE agent_sessions SET session_meta = 'broken json' WHERE session_id = 'malformed'")
    const roots = (await route('GET', '/sessions?grouped=1&limit=100')).body.data
    assert.deepEqual(roots.map(r => r.session_id), ['cross-host', 'cycle-a', 'cycle-b', 'invalid-parent', 'malformed', 'orphan-helper', 'parent', 'root-two', 'self-parent'])
    assert.equal(roots.find(r => r.session_id === 'parent').child_count, 6)
    assert.equal(roots.find(r => r.session_id === 'cycle-a').child_count, 1)
    const rootPages = []
    for (let offset = 0; offset < roots.length; offset += 2) rootPages.push(...(await route('GET', `/sessions?grouped=1&limit=2&offset=${offset}`)).body.data)
    assert.deepEqual(rootPages.map(r => r.session_id), roots.map(r => r.session_id))
    assert.equal((await route('GET', '/sessions?limit=100')).body.data.length, 17)
    const childPages = []
    for (let offset = 0; offset < 6; offset += 2) childPages.push(...(await route('GET', `/sessions/parent/children?vm_id=host-a&limit=2&offset=${offset}`)).body.data)
    assert.deepEqual(childPages.map(r => r.session_id), ['helper-0', 'helper-1', 'helper-2', 'helper-3', 'helper-4', 'versioned'])
    assert.equal(childPages[0].agent_nickname, 'Agent helper-0')
    assert.equal(childPages[0].agent_path, '/root/helper-0')
    assert.equal(childPages[0].parent_session_id, 'parent')
    assert.equal(childPages[0].child_count, 1)
    assert.deepEqual((await route('GET', '/sessions/helper-0/children?vm_id=host-a')).body.data.map(r => r.session_id), ['nested'])
    assert.equal((await route('GET', '/sessions/parent/children?vm_id=host-b')).status, 404)
    assert.deepEqual((await route('GET', '/sessions?grouped=1&source=claude')).body.data, [])
    await queries.upsertSessions([makeSession('parent', undefined, { project: '/outside', last_activity: '2026-09-01' })])
    const filtered = (await route('GET', '/sessions?grouped=1&project=group&from=2026-09-12&limit=100')).body.data
    assert.ok(filtered.some(r => r.session_id === 'helper-0'))
    assert.ok(!filtered.some(r => r.session_id === 'parent' || r.session_id === 'nested'))
    assert.deepEqual((await route('GET', '/sessions/parent/children?vm_id=host-a&project=group')).body.data, [])
    const detail = (await route('GET', '/sessions/helper-0?vm_id=host-a')).body.data
    assert.equal(detail.parent_session_id, 'parent')
    assert.equal(detail.agent_nickname, 'Agent helper-0')

  } finally {
    await pool.end()
  }
})
