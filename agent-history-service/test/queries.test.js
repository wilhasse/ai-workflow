import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSearchMessagesSql } from '../src/db/queries.js'

test('buildSearchMessagesSql keeps search results distinct without joining sessions', () => {
  const sql = buildSearchMessagesSql(value => JSON.stringify(String(value)), 'some questions from Jairo', {
    source: 'claude',
    vm_id: 'godev4',
    from: '2026-01-15',
    to: '2026-04-15',
    limit: 50,
    offset: 0,
  })

  assert.match(sql, /SELECT DISTINCT m\.message_id/)
  assert.doesNotMatch(sql, /LEFT JOIN agent_sessions/)
  assert.match(sql, /m\.source = "claude"/)
  assert.match(sql, /m\.vm_id = "godev4"/)
})
