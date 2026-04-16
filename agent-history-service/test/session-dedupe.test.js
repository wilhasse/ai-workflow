import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalizeSessionGroup, collapseSessionRows } from '../src/db/session-dedupe.js'

test('canonicalizeSessionGroup keeps earliest start and newest non-empty metadata fields', () => {
  const row = canonicalizeSessionGroup([
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'claude',
      started_at: '2026-04-01T10:00:00.000Z',
      project: null,
      display_text: null,
      session_meta: '{"startedAt":1}',
      message_count: 0,
      last_synced_at: '2026-04-01T10:00:01.000Z',
    },
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'claude',
      started_at: '2026-04-01T10:02:00.000Z',
      project: '-home-cslog-ai-workflow',
      display_text: 'first preview',
      session_meta: null,
      message_count: 2,
      last_synced_at: '2026-04-01T10:02:01.000Z',
    },
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'claude',
      started_at: '2026-04-01T10:05:00.000Z',
      project: '-home-cslog-ai-workflow',
      display_text: 'latest preview',
      session_meta: null,
      message_count: 1,
      last_synced_at: '2026-04-01T10:05:01.000Z',
    },
  ])

  assert.deepEqual(row, {
    session_id: 's1',
    vm_id: 'vm1',
    source: 'claude',
    started_at: '2026-04-01T10:00:00.000Z',
    project: '-home-cslog-ai-workflow',
    display_text: 'latest preview',
    session_meta: '{"startedAt":1}',
    message_count: 2,
    last_synced_at: '2026-04-01T10:05:01.000Z',
  })
})

test('collapseSessionRows emits one row per session/vm/source group', () => {
  const rows = collapseSessionRows([
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'claude',
      started_at: '2026-04-01T10:00:00.000Z',
      project: null,
      display_text: null,
      session_meta: null,
      message_count: 0,
      last_synced_at: '2026-04-01T10:00:01.000Z',
    },
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'claude',
      started_at: '2026-04-01T10:03:00.000Z',
      project: '-home-cslog-a',
      display_text: 'preview',
      session_meta: null,
      message_count: 0,
      last_synced_at: '2026-04-01T10:03:01.000Z',
    },
    {
      session_id: 's1',
      vm_id: 'vm1',
      source: 'codex',
      started_at: '2026-04-01T10:04:00.000Z',
      project: '/home/cslog/ai-workflow',
      display_text: 'codex preview',
      session_meta: '{"cwd":"/home/cslog/ai-workflow"}',
      message_count: 1,
      last_synced_at: '2026-04-01T10:04:01.000Z',
    },
  ])

  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.source === 'claude')?.display_text, 'preview')
  assert.equal(rows.find(row => row.source === 'codex')?.session_meta, '{"cwd":"/home/cslog/ai-workflow"}')
})
