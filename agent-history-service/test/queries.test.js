import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSearchMessagesSql } from '../src/db/queries.js'

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
})
