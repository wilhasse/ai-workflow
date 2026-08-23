import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { codexControlRequest, codexControlUrl } from '../../api/codexControl'
import ComparisonPanel from './ComparisonPanel'
import './AgentBoard.css'

const EVENT_TYPES = [
  'snapshot',
  'threads.refreshed',
  'thread.created',
  'thread.resumed',
  'turn.started',
  'turn.steered',
  'turn.interrupted',
  'approval.requested',
  'approval.resolved',
  'comparison.started',
  'comparison.updated',
  'comparison.completed',
  'appServer.notification',
  'appServer.disconnected',
]

const formatDate = (value) => {
  const timestamp = Number(value || 0)
  if (!timestamp) return ''
  return new Date(timestamp < 100000000000 ? timestamp * 1000 : timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const formatTokens = (value) => {
  const tokens = Number(value || 0)
  return tokens ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens) : '—'
}

const shortId = (value) => value?.length > 16 ? `${value.slice(0, 16)}…` : value

const mergeById = (current, next) => {
  const records = new Map(current.map((item) => [item.id, item]))
  for (const item of next) records.set(item.id, { ...records.get(item.id), ...item })
  return Array.from(records.values())
}

function ApprovalCard({ approval, busy, onDecision }) {
  const description = approval.kind === 'command'
    ? approval.command || 'Command execution request'
    : approval.grantRoot || 'File change request'
  return (
    <article className="ab-approval">
      <div>
        <strong>{approval.kind === 'command' ? 'Command approval' : 'File change approval'}</strong>
        <code>{description}</code>
        {approval.reason && <p>{approval.reason}</p>}
        {approval.cwd && <small>{approval.cwd}</small>}
      </div>
      <div className="ab-approval-actions">
        <button className="primary" type="button" disabled={busy} onClick={() => onDecision(approval.id, 'accept')}>Allow once</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => onDecision(approval.id, 'acceptForSession')}>Allow session</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => onDecision(approval.id, 'decline')}>Decline</button>
        <button className="danger" type="button" disabled={busy} onClick={() => onDecision(approval.id, 'cancel')}>Cancel turn</button>
      </div>
    </article>
  )
}

function ThreadCard({ thread, selected, onSelect }) {
  return (
    <button className={`ab-thread-card ${selected ? 'selected' : ''}`} type="button" onClick={onSelect}>
      <span className="ab-thread-top">
        <strong>{thread.name || thread.preview || shortId(thread.id)}</strong>
        <span className={`ab-status ${thread.status}`}>{thread.status}</span>
      </span>
      <span className="ab-runtime-row">
        {thread.model && <span>{thread.model}</span>}
        {thread.modelProvider && <span>{thread.modelProvider}</span>}
        {thread.reasoningEffort && <span>{thread.reasoningEffort}</span>}
        <span>{formatTokens(thread.tokensUsed)} tokens</span>
      </span>
      <span className="ab-thread-meta">
        <span title={thread.id}>{shortId(thread.id)}</span>
        <span title={thread.cwd}>{thread.cwd}</span>
        <span>{formatDate(thread.updatedAt)}</span>
      </span>
    </button>
  )
}

export default function AgentBoard() {
  const [presets, setPresets] = useState([])
  const [threads, setThreads] = useState([])
  const [approvals, setApprovals] = useState([])
  const [comparisons, setComparisons] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [turnPrompt, setTurnPrompt] = useState('')
  const [createForm, setCreateForm] = useState({
    preset: 'default',
    cwd: '',
    prompt: '',
    sandbox: 'workspaceWrite',
    approvalPolicy: 'onRequest',
  })
  const refreshTimer = useRef(null)

  const refresh = useCallback(async () => {
    const [{ presets: presetData }, threadData] = await Promise.all([
      codexControlRequest('/presets'),
      codexControlRequest('/threads'),
    ])
    setPresets(presetData)
    setThreads(threadData.threads || [])
    setApprovals(threadData.approvals || [])
  }, [])

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      refresh().catch((nextError) => setError(nextError.message))
    }, 250)
  }, [refresh])

  useEffect(() => {
    refresh()
      .catch((nextError) => setError(nextError.message))
      .finally(() => setLoading(false))
    const events = new EventSource(codexControlUrl('/events'))
    const handleEvent = (event) => {
      setConnected(true)
      const payload = JSON.parse(event.data)
      if (event.type === 'snapshot') {
        setPresets(payload.presets || [])
        setThreads(payload.threads || [])
        setApprovals(payload.approvals || [])
        setComparisons(payload.comparisons || [])
        return
      }
      const comparison = payload.data?.comparison
      if (comparison) setComparisons((current) => mergeById(current, [comparison]))
      const eventThread = payload.data?.thread
      if (eventThread) setThreads((current) => mergeById(current, [eventThread]))
      const threadPatch = payload.data?.threadPatch
      if (threadPatch) {
        setThreads((current) => current.map((thread) => {
          if (thread.id !== threadPatch.id) return thread
          const { agentMessageDelta, ...fields } = threadPatch
          return {
            ...thread,
            ...fields,
            lastAgentMessage: agentMessageDelta
              ? `${thread.lastAgentMessage || ''}${agentMessageDelta}`.slice(-50000)
              : fields.lastAgentMessage ?? thread.lastAgentMessage,
          }
        }))
      }
      if (event.type === 'approval.requested') {
        setApprovals((current) => mergeById(current, [payload.data.approval]))
      } else if (event.type === 'approval.resolved') {
        setApprovals((current) => current.filter((approval) => approval.id !== payload.data.approvalId))
      } else if (event.type === 'threads.refreshed' || event.type === 'appServer.disconnected') {
        scheduleRefresh()
      }
    }
    EVENT_TYPES.forEach((type) => events.addEventListener(type, handleEvent))
    events.onerror = () => setConnected(false)
    return () => {
      window.clearTimeout(refreshTimer.current)
      events.close()
    }
  }, [refresh, scheduleRefresh])

  useEffect(() => {
    if (!selectedId && threads.length) setSelectedId(threads[0].id)
  }, [selectedId, threads])

  const selectedThread = threads.find((thread) => thread.id === selectedId) || null
  const visibleThreads = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return threads.filter((thread) => !needle || [
      thread.id,
      thread.name,
      thread.preview,
      thread.cwd,
      thread.model,
      thread.modelProvider,
    ].join(' ').toLowerCase().includes(needle)).slice(0, 80)
  }, [query, threads])

  const run = async (key, action) => {
    setBusy(key)
    setError('')
    try {
      return await action()
    } catch (nextError) {
      setError(nextError.message || 'Agent Board request failed')
      return null
    } finally {
      setBusy('')
    }
  }

  const createThread = async (event) => {
    event.preventDefault()
    const payload = await run('create', () => codexControlRequest('/threads', { method: 'POST', body: createForm }))
    if (!payload) return
    setThreads((current) => mergeById(current, [payload.thread]))
    setSelectedId(payload.thread.id)
    setCreateForm((current) => ({ ...current, prompt: '' }))
  }

  const selectThread = async (threadId) => {
    setSelectedId(threadId)
    const payload = await run('read', () => codexControlRequest(`/threads/${encodeURIComponent(threadId)}`))
    if (payload?.thread) setThreads((current) => mergeById(current, [payload.thread]))
  }

  const threadAction = async (action) => {
    if (!selectedThread) return
    const path = action === 'turns' ? 'turns' : action
    const body = action === 'interrupt' ? {} : { prompt: turnPrompt }
    const payload = await run(action, () => codexControlRequest(
      `/threads/${encodeURIComponent(selectedThread.id)}/${path}`,
      { method: 'POST', body },
    ))
    if (payload && action !== 'interrupt') setTurnPrompt('')
    scheduleRefresh()
  }

  const resume = async () => {
    if (!selectedThread) return
    await run('resume', () => codexControlRequest(
      `/threads/${encodeURIComponent(selectedThread.id)}/resume`,
      { method: 'POST' },
    ))
    scheduleRefresh()
  }

  const resolveApproval = async (approvalId, decision) => {
    await run(`approval-${approvalId}`, () => codexControlRequest(
      `/approvals/${encodeURIComponent(approvalId)}`,
      { method: 'POST', body: { decision } },
    ))
    scheduleRefresh()
  }

  const startComparison = async (input) => {
    const payload = await run('compare', () => codexControlRequest('/compare', { method: 'POST', body: input }))
    if (payload?.comparison) setComparisons((current) => mergeById(current, [payload.comparison]))
  }

  return (
    <section className="ab-view">
      <header className="ab-toolbar">
        <div>
          <h2>Agent Board</h2>
          <p>Codex app-server threads, live events, approvals, steering, and safe provider comparisons.</p>
        </div>
        <div className="ab-connection">
          <span className={connected ? 'connected' : 'disconnected'}>{connected ? 'Live' : 'Reconnecting'}</span>
          <button className="secondary" type="button" onClick={() => refresh()} disabled={loading}>Refresh</button>
        </div>
      </header>

      {error && <div className="ab-error">{error}</div>}

      {approvals.length > 0 && (
        <section className="ab-panel">
          <header className="ab-panel-header"><h3>Pending approvals ({approvals.length})</h3></header>
          <div className="ab-approval-list">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                busy={busy === `approval-${approval.id}`}
                onDecision={resolveApproval}
              />
            ))}
          </div>
        </section>
      )}

      <div className="ab-main-grid">
        <section className="ab-panel ab-thread-list-panel">
          <header className="ab-panel-header">
            <div><h3>Threads</h3><p>{threads.length} indexed · showing {visibleThreads.length}</p></div>
          </header>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by prompt, cwd, id, model, or provider" />
          <div className="ab-thread-list">
            {loading && !threads.length && <div className="ab-empty">Loading threads…</div>}
            {visibleThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedId}
                onSelect={() => selectThread(thread.id)}
              />
            ))}
          </div>
        </section>

        <div className="ab-work-column">
          <section className="ab-panel">
            <header className="ab-panel-header"><h3>Start controlled thread</h3></header>
            <form className="ab-create-form" onSubmit={createThread}>
              <select value={createForm.preset} onChange={(event) => setCreateForm((current) => ({ ...current, preset: event.target.value }))}>
                {presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
              </select>
              <input value={createForm.cwd} onChange={(event) => setCreateForm((current) => ({ ...current, cwd: event.target.value }))} placeholder="Workspace path (blank uses ai-workflow)" />
              <select value={createForm.sandbox} onChange={(event) => setCreateForm((current) => ({ ...current, sandbox: event.target.value }))}>
                <option value="workspaceWrite">Workspace write</option>
                <option value="readOnly">Read only</option>
              </select>
              <select value={createForm.approvalPolicy} onChange={(event) => setCreateForm((current) => ({ ...current, approvalPolicy: event.target.value }))}>
                <option value="onRequest">Ask on request</option>
                <option value="never">Never ask</option>
                <option value="untrusted">Ask for untrusted commands</option>
              </select>
              <textarea value={createForm.prompt} onChange={(event) => setCreateForm((current) => ({ ...current, prompt: event.target.value }))} rows={3} placeholder="Initial prompt (optional)" />
              <button className="primary" type="submit" disabled={busy === 'create'}>{busy === 'create' ? 'Starting…' : 'Start thread'}</button>
            </form>
          </section>

          <section className="ab-panel ab-thread-detail">
            <header className="ab-panel-header">
              <div>
                <h3>{selectedThread ? selectedThread.name || selectedThread.preview || selectedThread.id : 'Select a thread'}</h3>
                {selectedThread && <p>{selectedThread.cwd}</p>}
              </div>
              {selectedThread && <span className={`ab-status ${selectedThread.status}`}>{selectedThread.status}</span>}
            </header>
            {selectedThread ? (
              <>
                <div className="ab-runtime-row detail">
                  <span>{selectedThread.model || 'model pending'}</span>
                  <span>{selectedThread.modelProvider || 'provider pending'}</span>
                  {selectedThread.reasoningEffort && <span>{selectedThread.reasoningEffort}</span>}
                  <span>{formatTokens(selectedThread.tokensUsed)} tokens</span>
                </div>
                {selectedThread.plan && <pre className="ab-plan">{typeof selectedThread.plan === 'string' ? selectedThread.plan : JSON.stringify(selectedThread.plan, null, 2)}</pre>}
                <pre className="ab-output">{selectedThread.lastAgentMessage || selectedThread.preview || 'No agent output loaded yet.'}</pre>
                {selectedThread.diff && <details><summary>Current diff</summary><pre className="ab-diff">{selectedThread.diff}</pre></details>}
                <textarea value={turnPrompt} onChange={(event) => setTurnPrompt(event.target.value)} rows={3} placeholder="New turn or steering instruction" />
                <div className="ab-thread-actions">
                  {selectedThread.status === 'notLoaded' && <button className="secondary" type="button" onClick={resume} disabled={Boolean(busy)}>Resume</button>}
                  <button className="primary" type="button" onClick={() => threadAction('turns')} disabled={Boolean(busy) || !turnPrompt.trim()}>Start turn</button>
                  <button className="secondary" type="button" onClick={() => threadAction('steer')} disabled={Boolean(busy) || selectedThread.status !== 'active' || !turnPrompt.trim()}>Steer active turn</button>
                  <button className="danger" type="button" onClick={() => threadAction('interrupt')} disabled={Boolean(busy) || selectedThread.status !== 'active'}>Interrupt</button>
                </div>
              </>
            ) : <div className="ab-empty">Choose a thread to inspect or continue.</div>}
          </section>
        </div>
      </div>

      <ComparisonPanel
        presets={presets}
        comparisons={comparisons}
        defaultCwd={createForm.cwd}
        busy={busy === 'compare'}
        onStart={startComparison}
      />
    </section>
  )
}
