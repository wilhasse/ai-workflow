import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parse } from '../src/parsers/codex-sessions.js'

test('Codex parser emits direct prompts but skips injected user context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-session-parser-'))
  const filePath = path.join(
    directory,
    'rollout-2026-08-30T15-32-42-01a053f1-fb4e-7cf1-b790-9c70a2eb154b.jsonl',
  )
  const records = [
    {
      type: 'session_meta',
      timestamp: '2026-08-30T18:32:42.000Z',
      payload: {
        id: '01a053f1-fb4e-7cf1-b790-9c70a2eb154b',
        cwd: '/repo',
        source: 'cli',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
      },
    },
    { type: 'turn_context', payload: {} },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first real prompt' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first answer' }],
      },
    },
    { type: 'turn_context', payload: {} },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'last real prompt' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'last answer' }],
      },
    },
  ]
  await writeFile(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)

  const parsed = []
  let processedLine = 0
  for await (const record of parse(filePath, 0, (line) => { processedLine = line })) parsed.push(record)
  const messages = parsed.filter(record => record._table === 'messages')

  const reparsed = []
  for await (const record of parse(filePath)) reparsed.push(record)
  const reparsedMessages = reparsed.filter(record => record._table === 'messages')

  assert.deepEqual(
    messages.map(message => [message.role, message.content_text]),
    [
      ['user', 'first real prompt'],
      ['assistant', 'first answer'],
      ['user', 'last real prompt'],
      ['assistant', 'last answer'],
    ],
  )
  assert.deepEqual(
    messages.map(message => message.message_id),
    reparsedMessages.map(message => message.message_id),
  )
  assert.deepEqual(messages.map(message => message.seq_num), [4, 5, 7, 8])
  assert.equal(processedLine, records.length)
})
