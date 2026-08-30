import test from 'node:test'
import assert from 'node:assert/strict'

import { buildListSessionsSql, buildSearchMessagesSql } from '../src/db/queries.js'

test('buildSearchMessagesSql ranks flexible message search and applies filters', () => {
  const sql = buildSearchMessagesSql(value => JSON.stringify(String(value)), 'some questions from Jairo', {
    source: 'claude',
    vm_id: 'godev4',
    project: 'ai-workflow',
    from: '2026-01-15',
    to: '2026-04-15',
    limit: 50,
    offset: 0,
  })

  assert.match(sql, /SELECT DISTINCT m\.message_id/)
  assert.match(sql, /LEFT JOIN/)
  assert.match(sql, /MATCH_PHRASE 'some questions from Jairo'/)
  assert.match(sql, /MATCH_ANY 'some questions from Jairo'/)
  assert.ok(sql.includes('LIKE LOWER("%some questions from Jairo%")'))
  assert.match(sql, /m\.source = "claude"/)
  assert.match(sql, /m\.vm_id = "godev4"/)
  assert.ok(sql.includes('s.project LIKE "%ai-workflow%"'))
  assert.match(sql, /ORDER BY relevance ASC, m\.ts DESC/)
  assert.match(sql, /session_meta NOT LIKE/)
  assert.match(sql, /m\.msg_role != 'user'/)
  assert.ok(sql.includes('m.content_text NOT LIKE "# AGENTS.md instructions%"'))
})

test('buildSearchMessagesSql includes subagents only when requested', () => {
  const sql = buildSearchMessagesSql(value => JSON.stringify(String(value)), 'retry design', {
    include_subagents: '1',
  })

  assert.doesNotMatch(sql, /session_meta NOT LIKE/)
})

test('buildListSessionsSql hides Codex subagents by default', () => {
  const sql = buildListSessionsSql(value => JSON.stringify(String(value)), {
    source: 'codex',
    limit: 50,
  })

  assert.match(sql, /source != 'codex' OR session_meta IS NULL OR session_meta NOT LIKE/)
})

test('buildListSessionsSql canonicalizes stale session rows before filtering and pagination', () => {
  const sql = buildListSessionsSql(value => JSON.stringify(String(value)), {
    source: 'claude',
    from: '2026-08-29',
    to: '2026-08-29',
    limit: 50,
    offset: 50,
  })

  assert.match(sql, /MIN\(started_at\) AS started_at/)
  assert.match(sql, /GROUP BY session_id, vm_id, source/)
  assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM agent_sessions[\s\S]+GROUP BY session_id, vm_id, source\s*\) sessions/)
  assert.match(sql, /WHERE source = "claude" AND started_at >= "2026-08-29"/)
  assert.match(sql, /ORDER BY started_at DESC LIMIT 50 OFFSET 50/)
})
