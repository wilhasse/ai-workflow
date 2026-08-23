import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  buildThreadStartParams,
  getPreset,
  InputError,
  PRESETS,
  validateComparisonPresets,
  validateText,
} from './presets.js'

const MAX_MESSAGE_CHARS = 50000
const MAX_DIFF_CHARS = 100000

const errorMessage = (error) => error instanceof Error ? error.message : String(error)

const statusName = (status) => {
  if (!status) return 'unknown'
  if (typeof status === 'string') return status
  if (typeof status.type === 'string') return status.type
  if (status.active) return 'active'
  return Object.keys(status)[0] || 'unknown'
}

const boundedText = (value, maxLength = MAX_MESSAGE_CHARS) => {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…truncated…` : text
}

const publicThread = (thread) => {
  if (!thread) return null
  const { drafts: _drafts, itemsById: _itemsById, ...result } = thread
  return {
    ...result,
    items: Array.from(_itemsById?.values?.() || []).slice(-100),
  }
}

const publicApproval = (approval) => {
  if (!approval) return null
  const { rpcId: _rpcId, ...result } = approval
  return result
}

export class ControlService extends EventEmitter {
  constructor({ client, config }) {
    super()
    this.client = client
    this.config = config
    this.threads = new Map()
    this.approvals = new Map()
    this.comparisons = new Map()
    this.archiveMetadata = new Map()
    this.events = []
    this.refreshTimer = null
    this.startedAt = Date.now()
    this.client.on('notification', (message) => this.#handleNotification(message))
    this.client.on('serverRequest', (message) => this.#handleServerRequest(message))
    this.client.on('exit', (error) => this.#publish('appServer.disconnected', { error: errorMessage(error) }))
  }

  async start() {
    await this.client.start()
    await this.refreshThreads()
    this.refreshTimer = setInterval(() => {
      this.refreshThreads().catch((error) => {
        this.#publish('threads.refreshFailed', { error: errorMessage(error) })
      })
    }, this.config.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  async stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    await this.client.stop()
  }

  health() {
    return {
      ok: this.client.status.ready,
      service: 'codex-control-service',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      appServer: this.client.status,
      counts: {
        threads: this.threads.size,
        approvals: this.approvals.size,
        comparisons: this.comparisons.size,
      },
    }
  }

  presets() {
    return Object.values(PRESETS)
  }

  snapshot() {
    return {
      health: this.health(),
      presets: this.presets(),
      threads: this.listCachedThreads(),
      approvals: Array.from(this.approvals.values()).map(publicApproval),
      comparisons: Array.from(this.comparisons.values()),
    }
  }

  listCachedThreads() {
    return Array.from(this.threads.values())
      .map(publicThread)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, this.config.maxThreads)
  }

  async #loadArchiveMetadata() {
    let payload
    try {
      payload = JSON.parse(await fs.readFile(this.config.archivePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#publish('archive.readFailed', { error: errorMessage(error) })
      }
      return
    }
    this.archiveMetadata = new Map(
      (Array.isArray(payload.records) ? payload.records : [])
        .filter((record) => record?.kind === 'codex' && record.resumeId)
        .map((record) => [String(record.resumeId), {
          model: record.model || '',
          modelProvider: record.modelProvider || '',
          reasoningEffort: record.reasoningEffort || '',
          tokensUsed: Number(record.tokensUsed || 0),
        }]),
    )
  }

  #upsertThread(source, extra = {}) {
    const id = String(source?.id || source?.threadId || '')
    if (!id) return null
    const current = this.threads.get(id) || {
      id,
      itemsById: new Map(),
      drafts: {},
      createdAt: 0,
    }
    const archived = this.archiveMetadata.get(id) || {}
    const next = {
      ...current,
      id,
      name: source.name ?? current.name ?? '',
      preview: source.preview ?? current.preview ?? '',
      cwd: String(source.cwd ?? extra.cwd ?? current.cwd ?? ''),
      model: extra.model ?? source.model ?? current.model ?? archived.model ?? '',
      modelProvider: extra.modelProvider ?? source.modelProvider ?? current.modelProvider ?? archived.modelProvider ?? '',
      reasoningEffort: extra.reasoningEffort ?? source.reasoningEffort ?? current.reasoningEffort ?? archived.reasoningEffort ?? '',
      tokensUsed: Number(extra.tokensUsed ?? current.tokensUsed ?? archived.tokensUsed ?? 0),
      status: statusName(source.status ?? extra.status ?? current.status),
      activeFlags: source.status?.active?.activeFlags || source.status?.activeFlags || current.activeFlags || [],
      createdAt: Number(source.createdAt ?? current.createdAt ?? 0),
      updatedAt: Number(source.updatedAt ?? current.updatedAt ?? Date.now() / 1000),
      ephemeral: Boolean(source.ephemeral ?? current.ephemeral),
      source: source.source ?? current.source ?? null,
      itemsById: current.itemsById,
      drafts: current.drafts,
    }
    this.threads.set(id, next)
    return next
  }

  async refreshThreads() {
    await this.#loadArchiveMetadata()
    let cursor
    let loaded = 0
    do {
      const result = await this.client.request('thread/list', {
        cursor,
        limit: Math.min(100, this.config.maxThreads - loaded),
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly: true,
      })
      for (const thread of result.data || []) this.#upsertThread(thread)
      loaded += result.data?.length || 0
      cursor = result.nextCursor || undefined
    } while (cursor && loaded < this.config.maxThreads)
    this.#publish('threads.refreshed', { count: loaded })
    return this.listCachedThreads()
  }

  async readThread(threadId) {
    const result = await this.client.request('thread/read', {
      threadId: String(threadId),
      includeTurns: true,
    })
    const thread = this.#upsertThread(result.thread)
    for (const turn of result.thread?.turns || []) {
      for (const item of turn.items || []) thread.itemsById.set(item.id, item)
      thread.lastTurn = turn
      const message = [...(turn.items || [])].reverse().find((item) => item.type === 'agentMessage')
      if (message?.text) thread.lastAgentMessage = boundedText(message.text)
    }
    return publicThread(thread)
  }

  async createThread(input = {}) {
    const { preset, params } = buildThreadStartParams(input, this.config)
    const result = await this.client.request('thread/start', params)
    const thread = this.#upsertThread(result.thread, {
      cwd: result.cwd,
      model: result.model,
      modelProvider: result.modelProvider,
      reasoningEffort: result.reasoningEffort,
    })
    thread.preset = preset.id
    thread.sandbox = result.sandbox || params.sandbox
    thread.approvalPolicy = result.approvalPolicy || params.approvalPolicy
    this.#publish('thread.created', { thread: publicThread(thread) })
    let turn = null
    if (String(input.prompt || '').trim()) {
      turn = await this.startTurn(thread.id, { prompt: input.prompt })
    }
    return { thread: publicThread(thread), turn, preset }
  }

  async resumeThread(threadId) {
    const result = await this.client.request('thread/resume', { threadId: String(threadId) })
    const thread = this.#upsertThread(result.thread, {
      cwd: result.cwd,
      model: result.model,
      modelProvider: result.modelProvider,
      reasoningEffort: result.reasoningEffort,
    })
    thread.sandbox = result.sandbox
    thread.approvalPolicy = result.approvalPolicy
    this.#publish('thread.resumed', { thread: publicThread(thread) })
    return publicThread(thread)
  }

  async #ensureLoaded(threadId) {
    const thread = this.threads.get(String(threadId))
    if (!thread || thread.status === 'notLoaded') await this.resumeThread(threadId)
  }

  async startTurn(threadId, input = {}) {
    const id = String(threadId)
    const prompt = validateText(input.prompt, 'prompt')
    await this.#ensureLoaded(id)
    const existing = this.#upsertThread({ id }, { status: 'active' })
    existing.lastAgentMessage = ''
    const result = await this.client.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: prompt, textElements: [] }],
    })
    const thread = this.#upsertThread({ id }, { status: 'active' })
    const completedAlready = thread.lastTurn?.id === result.turn.id
      && thread.lastTurn.status !== 'inProgress'
    if (!completedAlready) {
      thread.lastTurn = result.turn
      thread.activeTurnId = result.turn.id
    }
    thread.lastUserMessage = prompt
    thread.updatedAt = Date.now() / 1000
    this.#publish('turn.started', { threadId: id, turn: result.turn, thread: publicThread(thread) })
    return result.turn
  }

  async steerTurn(threadId, input = {}) {
    const id = String(threadId)
    const prompt = validateText(input.prompt, 'prompt')
    const thread = this.threads.get(id)
    const expectedTurnId = String(input.expectedTurnId || thread?.activeTurnId || '')
    if (!expectedTurnId) throw new InputError('expectedTurnId is required for steering')
    const result = await this.client.request('turn/steer', {
      threadId: id,
      expectedTurnId,
      input: [{ type: 'text', text: prompt, textElements: [] }],
    })
    this.#publish('turn.steered', { threadId: id, turnId: result.turnId })
    return result
  }

  async interruptTurn(threadId, input = {}) {
    const id = String(threadId)
    const thread = this.threads.get(id)
    const turnId = String(input.turnId || thread?.activeTurnId || '')
    if (!turnId) throw new InputError('turnId is required for interruption')
    await this.client.request('turn/interrupt', { threadId: id, turnId })
    this.#publish('turn.interrupted', { threadId: id, turnId })
    return { threadId: id, turnId }
  }

  listApprovals() {
    return Array.from(this.approvals.values()).map(publicApproval)
  }

  resolveApproval(approvalId, input = {}) {
    const approval = this.approvals.get(String(approvalId))
    if (!approval) throw new InputError('Approval request not found', 404)
    const decision = String(input.decision || '')
    const allowed = ['accept', 'acceptForSession', 'decline', 'cancel']
    if (!allowed.includes(decision)) throw new InputError(`Unsupported approval decision: ${decision}`)
    this.client.respond(approval.rpcId, { decision })
    this.approvals.delete(approval.id)
    this.#publish('approval.resolved', { approvalId: approval.id, decision })
    return { approvalId: approval.id, decision }
  }

  async startComparison(input = {}) {
    const prompt = validateText(input.prompt, 'prompt')
    const presetIds = validateComparisonPresets(input.presets)
    const comparison = {
      id: randomUUID(),
      status: 'running',
      prompt,
      cwd: buildThreadStartParams({ cwd: input.cwd, sandbox: 'readOnly', approvalPolicy: 'never' }, this.config).params.cwd,
      createdAt: Date.now(),
      completedAt: null,
      entries: presetIds.map((presetId) => ({ preset: presetId, status: 'queued' })),
    }
    this.comparisons.set(comparison.id, comparison)
    this.#publish('comparison.started', { comparison })
    void this.#runComparison(comparison)
    return comparison
  }

  getComparison(comparisonId) {
    const comparison = this.comparisons.get(String(comparisonId))
    if (!comparison) throw new InputError('Comparison not found', 404)
    return comparison
  }

  async #runComparison(comparison) {
    await Promise.all(comparison.entries.map(async (entry) => {
      entry.status = 'starting'
      this.#publish('comparison.updated', { comparison })
      try {
        const created = await this.createThread({
          preset: entry.preset,
          cwd: comparison.cwd,
          sandbox: 'readOnly',
          approvalPolicy: 'never',
          ephemeral: true,
        })
        entry.threadId = created.thread.id
        entry.model = created.thread.model
        entry.modelProvider = created.thread.modelProvider
        entry.reasoningEffort = created.thread.reasoningEffort
        entry.status = 'running'
        const turn = await this.startTurn(created.thread.id, { prompt: comparison.prompt })
        entry.turnId = turn.id
        const completed = await this.#waitForTurn(created.thread.id, turn.id)
        const thread = this.threads.get(created.thread.id)
        entry.status = completed.status === 'completed' ? 'completed' : completed.status
        entry.output = thread?.lastAgentMessage || ''
        entry.tokenUsage = thread?.tokenUsage || null
        entry.durationMs = completed.durationMs ?? null
        if (completed.error) entry.error = completed.error.message || String(completed.error)
      } catch (error) {
        entry.status = 'failed'
        entry.error = errorMessage(error)
      }
      this.#publish('comparison.updated', { comparison })
    }))
    comparison.status = comparison.entries.every((entry) => entry.status === 'completed')
      ? 'completed'
      : 'completedWithErrors'
    comparison.completedAt = Date.now()
    this.#publish('comparison.completed', { comparison })
  }

  #waitForTurn(threadId, turnId) {
    const current = this.threads.get(threadId)?.lastTurn
    if (current?.id === turnId && current.status !== 'inProgress') return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('turnCompleted', listener)
        reject(new Error(`Turn timed out after ${this.config.comparisonTimeoutMs}ms`))
      }, this.config.comparisonTimeoutMs)
      const listener = (event) => {
        if (event.threadId !== threadId || event.turn.id !== turnId) return
        clearTimeout(timeout)
        this.off('turnCompleted', listener)
        resolve(event.turn)
      }
      this.on('turnCompleted', listener)
    })
  }

  #handleNotification(message) {
    const { method, params = {} } = message
    const threadId = String(params.threadId || params.thread?.id || '')
    let thread = threadId ? this.#upsertThread(params.thread || { id: threadId }) : null
    if (method === 'thread/status/changed' && thread) {
      thread.status = statusName(params.status)
      thread.activeFlags = params.status?.active?.activeFlags || params.status?.activeFlags || []
    } else if (method === 'thread/settings/updated' && thread) {
      const settings = params.threadSettings || {}
      thread.model = settings.model || thread.model
      thread.modelProvider = settings.modelProvider || thread.modelProvider
      thread.reasoningEffort = settings.effort || thread.reasoningEffort
      thread.cwd = settings.cwd || thread.cwd
    } else if (method === 'turn/started' && thread) {
      thread.lastTurn = params.turn
      thread.activeTurnId = params.turn?.id || ''
      thread.status = 'active'
    } else if (method === 'turn/completed' && thread) {
      thread.lastTurn = params.turn
      thread.activeTurnId = ''
      thread.status = 'idle'
      thread.updatedAt = Date.now() / 1000
      this.emit('turnCompleted', { threadId, turn: params.turn })
    } else if ((method === 'item/started' || method === 'item/completed') && thread && params.item?.id) {
      thread.itemsById.set(params.item.id, params.item)
      if (thread.itemsById.size > 100) thread.itemsById.delete(thread.itemsById.keys().next().value)
      if (params.item.type === 'agentMessage' && params.item.text) {
        thread.lastAgentMessage = boundedText(params.item.text)
      }
      if (params.item.type === 'plan' && params.item.text) thread.plan = boundedText(params.item.text)
    } else if (method === 'item/agentMessage/delta' && thread) {
      const itemId = String(params.itemId || 'agent')
      thread.drafts[itemId] = boundedText(`${thread.drafts[itemId] || ''}${params.delta || ''}`)
      thread.lastAgentMessage = thread.drafts[itemId]
    } else if (method === 'thread/tokenUsage/updated' && thread) {
      thread.tokenUsage = params.tokenUsage || null
      thread.tokensUsed = Number(params.tokenUsage?.total?.totalTokens || thread.tokensUsed || 0)
    } else if (method === 'turn/diff/updated' && thread) {
      thread.diff = boundedText(params.diff, MAX_DIFF_CHARS)
    } else if (method === 'turn/plan/updated' && thread) {
      thread.plan = params.plan || []
    }
    const threadPatch = thread ? {
      id: thread.id,
      status: thread.status,
      activeFlags: thread.activeFlags,
      activeTurnId: thread.activeTurnId,
      updatedAt: thread.updatedAt,
      tokensUsed: thread.tokensUsed,
      tokenUsage: thread.tokenUsage,
    } : null
    if (threadPatch && method === 'item/agentMessage/delta') {
      threadPatch.agentMessageDelta = boundedText(params.delta, 10000)
    }
    if (threadPatch && ['item/completed', 'turn/completed'].includes(method)) {
      threadPatch.lastAgentMessage = thread.lastAgentMessage
      threadPatch.plan = thread.plan
    }
    if (threadPatch && method === 'turn/diff/updated') threadPatch.diff = thread.diff
    if (threadPatch && method === 'turn/plan/updated') threadPatch.plan = thread.plan
    this.#publish('appServer.notification', { method, threadId, threadPatch })
  }

  #handleServerRequest(message) {
    const supported = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ])
    if (!supported.has(message.method)) {
      this.#publish('appServer.unsupportedRequest', { method: message.method })
      this.client.respondError?.(message.id, -32601, `Unsupported client request: ${message.method}`)
      return
    }
    const approval = {
      id: randomUUID(),
      rpcId: message.id,
      method: message.method,
      kind: message.method.includes('commandExecution') ? 'command' : 'fileChange',
      threadId: message.params?.threadId || '',
      turnId: message.params?.turnId || '',
      itemId: message.params?.itemId || '',
      reason: message.params?.reason || '',
      command: message.params?.command || '',
      cwd: message.params?.cwd || '',
      grantRoot: message.params?.grantRoot || '',
      availableDecisions: message.params?.availableDecisions || null,
      createdAt: Date.now(),
    }
    this.approvals.set(approval.id, approval)
    this.#publish('approval.requested', { approval: publicApproval(approval) })
  }

  #publish(type, data) {
    const event = { id: randomUUID(), type, at: Date.now(), data }
    this.events.push(event)
    this.events = this.events.slice(-this.config.maxEvents)
    this.emit('event', event)
  }
}

export { getPreset }
