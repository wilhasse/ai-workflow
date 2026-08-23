import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlService } from '../src/control-service.js'

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.status = { ready: true, pid: 1, lastError: '' }
    this.calls = []
    this.responses = []
    this.nextThread = 1
  }

  async start() {}
  async stop() {}

  async request(method, params) {
    this.calls.push({ method, params })
    if (method === 'thread/list') return { data: [], nextCursor: null }
    if (method === 'thread/start') {
      const id = `thread-${this.nextThread++}`
      return {
        thread: {
          id,
          cwd: params.cwd,
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
          ephemeral: params.ephemeral,
          modelProvider: params.modelProvider || 'openai',
        },
        cwd: params.cwd,
        model: params.model || 'gpt-default',
        modelProvider: params.modelProvider || 'openai',
        reasoningEffort: 'high',
        sandbox: params.sandbox,
        approvalPolicy: params.approvalPolicy,
      }
    }
    if (method === 'turn/start') {
      const turn = { id: `turn-${params.threadId}`, status: 'inProgress', items: [] }
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: params.threadId,
            turnId: turn.id,
            item: { id: `item-${params.threadId}`, type: 'agentMessage', text: `answer-${params.threadId}` },
          },
        })
        this.emit('notification', {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: params.threadId,
            turnId: turn.id,
            tokenUsage: { total: { totalTokens: 123 }, last: { totalTokens: 123 } },
          },
        })
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: { ...turn, status: 'completed', durationMs: 25 },
          },
        })
      })
      return { turn }
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }

  respond(id, result) {
    this.responses.push({ id, result })
  }
}

const setup = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-service-'))
  const client = new FakeClient()
  const config = {
    defaultCwd: cwd,
    allowedRoots: [cwd],
    archivePath: path.join(cwd, 'missing-archive.json'),
    refreshIntervalMs: 60000,
    comparisonTimeoutMs: 2000,
    maxEvents: 100,
    maxThreads: 50,
  }
  return { client, config, control: new ControlService({ client, config }), cwd }
}

test('creates controlled threads with the selected provider preset', async () => {
  const { client, control, cwd } = setup()
  const result = await control.createThread({ preset: 'qwen', cwd })
  const call = client.calls.find(({ method }) => method === 'thread/start')

  assert.deepEqual(
    {
      model: call.params.model,
      modelProvider: call.params.modelProvider,
      sandbox: call.params.sandbox,
      approvalPolicy: call.params.approvalPolicy,
    },
    {
      model: 'qwen3.8-max',
      modelProvider: 'cliproxy',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  )
  assert.equal(result.thread.model, 'qwen3.8-max')
})

test('comparison always uses ephemeral read-only threads with approvals disabled', async () => {
  const { client, control, cwd } = setup()
  const completedPromise = new Promise((resolve) => {
    const listener = (event) => {
      if (event.type !== 'comparison.completed') return
      control.off('event', listener)
      resolve(event)
    }
    control.on('event', listener)
  })
  const comparison = await control.startComparison({
    cwd,
    prompt: 'Reply OK',
    presets: ['default', 'k3', 'qwen'],
  })
  await completedPromise

  const starts = client.calls.filter(({ method }) => method === 'thread/start')
  assert.equal(starts.length, 3)
  assert.equal(starts.every(({ params }) => (
    params.sandbox === 'read-only'
      && params.approvalPolicy === 'never'
      && params.ephemeral === true
  )), true)
  assert.equal(comparison.status, 'completed')
  assert.deepEqual(comparison.entries.map(({ status }) => status), ['completed', 'completed', 'completed'])
  assert.equal(comparison.entries.every(({ output }) => output.startsWith('answer-thread-')), true)
})

test('routes approval decisions and active-turn controls through app-server', async () => {
  const { client, control, cwd } = setup()
  const created = await control.createThread({ cwd })
  const thread = control.threads.get(created.thread.id)
  thread.status = 'active'
  thread.activeTurnId = 'turn-active'
  client.emit('serverRequest', {
    id: 77,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: thread.id,
      turnId: 'turn-active',
      itemId: 'item-1',
      command: 'git status',
    },
  })

  const [approval] = control.listApprovals()
  assert.equal(approval.command, 'git status')
  assert.deepEqual(control.resolveApproval(approval.id, { decision: 'acceptForSession' }), {
    approvalId: approval.id,
    decision: 'acceptForSession',
  })
  assert.deepEqual(client.responses, [{ id: 77, result: { decision: 'acceptForSession' } }])

  assert.deepEqual(await control.steerTurn(thread.id, { prompt: 'focus on tests' }), { turnId: 'turn-active' })
  assert.deepEqual(await control.interruptTurn(thread.id), { threadId: thread.id, turnId: 'turn-active' })
})
