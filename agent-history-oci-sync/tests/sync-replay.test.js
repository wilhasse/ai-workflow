import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TABLES, loadState, saveState, runSync, decodeDorisField } from '../scripts/sync-core.js'
import { messageManifest, compareManifests } from '../scripts/sync-verification.js'

const messageSpec = TABLES.find(spec => spec.entity === 'messages')
const sessionSpec = TABLES.find(spec => spec.entity === 'sessions')
const historySpec = TABLES.find(spec => spec.entity === 'history')
const now = () => new Date('2026-09-12T16:00:00Z')
const message = (id, ts = '2026-09-12 14:00:00', text = id, vm = 'host-a') => ({ message_id: id, session_id: 'session', vm_id: vm, ts, content_text: text })

function compareRows(a, b, keys) {
  for (const key of keys) {
    const comparison = String(a[key]).localeCompare(String(b[key]))
    if (comparison) return comparison
  }
  return 0
}

function fixture(source, overrides = {}) {
  const cloud = new Map()
  let saved = { version: 2, modes: {} }
  const options = {
    state: saved, mode: 'delta', specs: [messageSpec], pageSize: 2, maxRows: 0,
    deadline: Infinity, overlapHours: 48, now,
    readUpper: async (spec, floor) => {
      const rows = (source[spec.entity] ?? []).filter(row => !floor || row.ts >= floor)
      return rows.sort((a, b) => compareRows(b, a, spec.keys))[0] ?? null
    },
    readPage: async (spec, checkpoint, limit) => (source[spec.entity] ?? [])
      .filter(row => compareRows(row, checkpoint.upperKey, spec.keys) <= 0
        && (!checkpoint.lastKey || compareRows(row, checkpoint.lastKey, spec.keys) > 0)
        && (!checkpoint.lowerBound || row.ts >= checkpoint.lowerBound))
      .sort((a, b) => compareRows(a, b, spec.keys)).slice(0, limit),
    postBatch: async (entity, rows) => {
      const spec = TABLES.find(candidate => candidate.entity === entity)
      for (const row of rows) {
        const keyRow = { ...row, ts: row.timestamp ?? row.ts }
        cloud.set(JSON.stringify([entity, ...spec.keys.map(key => keyRow[key])]), row)
      }
    },
    persist: async state => { saved = structuredClone(state) },
    ...overrides,
  }
  return { options, cloud, restart: () => { options.state = structuredClone(saved) }, saved: () => saved }
}

test('recent replay captures a late message behind the old high-watermark; complete sweep repairs an arbitrarily old arrival', async () => {
  const rows = [message('newer', '2026-09-12 15:00:00')]
  const f = fixture({ messages: rows })
  await runSync(f.options)
  rows.push(message('late-recent', '2026-09-11 15:00:00'), message('late-old', '2026-08-01 10:00:00'))
  await runSync(f.options)
  assert.deepEqual([...f.cloud.values()].map(row => row.message_id).sort(), ['late-recent', 'newer'])
  await runSync({ ...f.options, mode: 'reconcile' })
  assert.deepEqual([...f.cloud.values()].map(row => row.message_id).sort(), ['late-old', 'late-recent', 'newer'])
})

test('each delta cycle refreshes mutable session metadata and old history keys', async () => {
  const session = { session_id: 'session', vm_id: 'host-a', started_at: '2026-01-01 10:00:00', display_text: 'old title', message_count: 0 }
  const history = []
  const f = fixture({ sessions: [session], history }, { specs: [sessionSpec, historySpec] })
  await runSync(f.options)
  session.display_text = 'updated title'
  session.message_count = 12
  history.push({ session_id: 'session', vm_id: 'host-a', source: 'codex', ts: '2026-01-01 10:00:00', display_text: 'late history' })
  await runSync(f.options)
  assert.equal([...f.cloud.values()].find(row => row.started_at).display_text, 'updated title')
  assert.equal([...f.cloud.values()].find(row => row.started_at).message_count, 12)
  assert.equal([...f.cloud.values()].find(row => row.timestamp).display_text, 'late history')
})

test('lost acknowledgement does not advance cursor; restart replays the page idempotently', async () => {
  const f = fixture({ messages: [message('one'), message('two'), message('three')] })
  const send = f.options.postBatch
  let fail = true
  f.options.postBatch = async (...args) => {
    await send(...args)
    if (fail) { fail = false; throw new Error('acknowledgement lost') }
  }
  await assert.rejects(runSync(f.options), /acknowledgement lost/)
  assert.equal(f.saved().modes.delta.cycle.checkpoint.lastKey, null)
  assert.equal(f.saved().modes.delta.lastCompletedAt, undefined)
  f.restart()
  const result = await runSync(f.options)
  assert.equal(result.complete, true)
  assert.equal(f.cloud.size, 3)
  assert.equal(f.saved().modes.delta.lastCompletedAt, now().toISOString())
})

test('acknowledged page is durably resumed and the fixed upper key makes a growing source finite', async () => {
  const rows = [message('one'), message('two')]
  const f = fixture({ messages: rows }, { mode: 'reconcile', pageSize: 1, maxRows: 1 })
  let result = await runSync(f.options)
  assert.equal(result.complete, false)
  assert.equal(f.saved().modes.reconcile.cycle.checkpoint.rowsAcknowledged, 1)
  rows.push(message('future', '2026-09-12 17:00:00'))
  f.restart()
  result = await runSync({ ...f.options, maxRows: 0 })
  assert.equal(result.complete, true)
  assert.equal(f.cloud.size, 2)
  await runSync({ ...f.options, maxRows: 0 })
  assert.equal(f.cloud.size, 3)
})

test('old row inserted behind an active complete sweep is picked up by the following sweep', async () => {
  const rows = [message('first', '2026-08-01 10:00:00'), message('last', '2026-09-01 10:00:00')]
  const f = fixture({ messages: rows }, { mode: 'reconcile', maxRows: 1 })
  await runSync(f.options)
  rows.push(message('late', '2026-07-01 10:00:00'))
  f.restart()
  await runSync({ ...f.options, maxRows: 0 })
  assert.equal(f.cloud.size, 2)
  await runSync({ ...f.options, maxRows: 0 })
  assert.equal(f.cloud.size, 3)
})

test('deadline yields resumable progress without claiming a successful cycle', async () => {
  const f = fixture({ messages: [message('one')] }, { deadline: now().getTime() })
  const result = await runSync(f.options)
  assert.equal(result.complete, false)
  assert.equal(f.cloud.size, 0)
  assert.equal(f.saved().modes.delta.lastCompletedAt, undefined)
})

test('mode changes preserve independent progress and reject changing an unfinished selection', async () => {
  const f = fixture({ messages: [message('one'), message('two')] }, { maxRows: 1 })
  await runSync(f.options)
  await runSync({ ...f.options, mode: 'reconcile' })
  assert.ok(f.saved().modes.delta.cycle)
  assert.ok(f.saved().modes.reconcile.cycle)
  await assert.rejects(runSync({ ...f.options, specs: [historySpec] }), /tables differ/)
})

test('legacy event cursors are preserved but not trusted; atomic checkpoint is private and malformed state fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-sync-test-'))
  const filename = path.join(dir, 'state.json')
  try {
    const legacy = { agent_messages: { ts: '2026-09-12 14:00:00', session_id: 's', vm_id: 'host', message_id: 'm' } }
    fs.writeFileSync(filename, JSON.stringify(legacy))
    const state = loadState(filename)
    assert.deepEqual(state.legacyEventCursors, legacy)
    assert.deepEqual(state.modes, {})
    saveState(filename, state)
    assert.deepEqual(loadState(filename), state)
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
    fs.writeFileSync(filename, '{bad')
    assert.throws(() => loadState(filename), /Cannot read/)
    fs.writeFileSync(filename, JSON.stringify({ version: 2, modes: { delta: { cycle: { startedAt: 'invalid' } } } }))
    assert.throws(() => loadState(filename), /Invalid sync checkpoint/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('exact manifests find missing keys and changed text despite larger cloud counts, and separate host identities', () => {
  const source = messageManifest([message('same', undefined, 'original'), message('same', undefined, 'host-b text', 'host-b'), message('missing')])
  const cloud = messageManifest([message('same', undefined, 'changed'), message('same', undefined, 'host-b text', 'host-b'), message('extra-1'), message('extra-2')])
  const result = compareManifests(source, cloud)
  assert.equal(result.cloudMessages > result.sourceMessages, true)
  assert.equal(result.matched, false)
  assert.equal(result.missingCount, 1)
  assert.equal(result.changedTextCount, 1)
  assert.equal(result.cloudOnlyCount, 2)
  assert.equal(result.changedKeys[0][2], 'host-a')
  assert.equal(JSON.stringify(result).includes('original'), false)
})

test('manifest accepts API ISO timestamps and source SQL timestamps as the same key', () => {
  const source = messageManifest([message('same')])
  const cloud = messageManifest([{ ...message('same'), ts: '2026-09-12T14:00:00.000Z' }])
  assert.equal(compareManifests(source, cloud).matched, true)
  assert.throws(() => messageManifest([message('same'), message('same')]), /Duplicate/)
})


test('Doris text with non-BMP Unicode decodes from UTF-8 bytes and leaves numeric fields to mysql2', () => {
  const bytes = Buffer.from('conversation 🚀 𝄞', 'utf8')
  const legacyDecoded = 'conversation ' + '\ufffd'.repeat(4) + ' ' + '\ufffd'.repeat(4)
  const field = { type: 'VAR_STRING', string: (encoding = 'cesu8') => encoding === 'utf8' ? bytes.toString('utf8') : legacyDecoded }
  assert.notEqual(field.string(), 'conversation 🚀 𝄞')
  assert.equal(decodeDorisField(field, () => { throw new Error('legacy metadata decoder must not run') }), 'conversation 🚀 𝄞')
  assert.equal(decodeDorisField({ type: 'LONG' }, () => 42), 42)
  assert.equal(decodeDorisField({ type: 'BLOB', string: () => null }, () => 'wrong'), null)
})
