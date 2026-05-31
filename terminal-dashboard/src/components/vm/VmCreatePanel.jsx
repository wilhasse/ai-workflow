import { useCallback, useEffect, useMemo, useState } from 'react'

const DEFAULT_FORM = {
  name: '',
  node: 'pve1',
  cpuCores: 2,
  memoryMb: 4096,
  diskGb: 32,
  bridge: 'vmbr0',
  username: 'debian',
  sshPublicKey: '',
  description: '',
}

const JOB_DONE_STATUSES = new Set(['succeeded', 'failed'])

const formatMemory = (memoryMb) => {
  if (!memoryMb) return ''
  if (memoryMb % 1024 === 0) {
    return `${memoryMb / 1024} GB`
  }
  return `${memoryMb} MB`
}

const normalizeApiBase = (value) => (value || '').replace(/\/$/, '')

function VmCreatePanel({ apiBase }) {
  const [templates, setTemplates] = useState(null)
  const [templatesError, setTemplatesError] = useState('')
  const [form, setForm] = useState(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [job, setJob] = useState(null)

  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase])
  const selectedNode = useMemo(
    () => templates?.nodes?.find((node) => node.node === form.node) ?? null,
    [form.node, templates],
  )
  const featureEnabled = Boolean(templates?.enabled)

  const loadTemplates = useCallback(async () => {
    setTemplatesError('')
    try {
      const response = await fetch(`${base}/vm-templates`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || `Template request failed: ${response.status}`)
      }
      setTemplates(data)
      setForm((current) => ({
        ...current,
        node: data.defaults?.node || current.node,
        cpuCores: data.defaults?.cpuCores || current.cpuCores,
        memoryMb: data.defaults?.memoryMb || current.memoryMb,
        diskGb: data.defaults?.diskGb || current.diskGb,
        bridge: data.defaults?.bridge || current.bridge,
        username: data.defaults?.username || current.username,
      }))
    } catch (error) {
      setTemplatesError(error.message || 'Unable to load VM templates.')
    }
  }, [base])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  useEffect(() => {
    if (!job?.id || JOB_DONE_STATUSES.has(job.status)) {
      return undefined
    }

    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`${base}/vm-create/${encodeURIComponent(job.id)}`)
        const data = await response.json().catch(() => ({}))
        if (!cancelled && response.ok && data.job) {
          setJob(data.job)
        }
      } catch {
        // Keep the visible job state; the next poll may recover.
      }
    }, 2500)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [base, job])

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError('')
    setJob(null)
    try {
      const response = await fetch(`${base}/vm-create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...form,
          cpuCores: Number(form.cpuCores),
          memoryMb: Number(form.memoryMb),
          diskGb: Number(form.diskGb),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || `VM create failed: ${response.status}`)
      }
      setJob(data.job)
    } catch (error) {
      setSubmitError(error.message || 'Unable to create VM.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="vm-create-panel">
      <header className="vm-create-header">
        <div>
          <h2>Create test VM</h2>
          <p>Clone a Debian 13 cloud-init template on Proxmox and wait for DHCP IP detection.</p>
        </div>
        <button type="button" className="secondary" onClick={loadTemplates}>
          Refresh templates
        </button>
      </header>

      {templatesError && <div className="vm-create-alert error">{templatesError}</div>}
      {templates && !featureEnabled && (
        <div className="vm-create-alert">
          VM creation is disabled. Set <code>VM_CREATE_ENABLED=true</code> on the backend to enable this tool.
        </div>
      )}

      <div className="vm-create-layout">
        <form className="vm-create-form" onSubmit={handleSubmit}>
          <label>
            <span>VM name</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) => updateForm('name', event.target.value)}
              placeholder="debian-test-01"
              maxLength={48}
              required
            />
          </label>

          <label>
            <span>Proxmox node</span>
            <select
              value={form.node}
              onChange={(event) => updateForm('node', event.target.value)}
              disabled={!templates?.nodes?.length}
            >
              {(templates?.nodes || []).map((node) => (
                <option key={node.node} value={node.node}>
                  {node.node}
                </option>
              ))}
            </select>
          </label>

          <div className="vm-create-grid">
            <label>
              <span>CPU cores</span>
              <input
                type="number"
                min="1"
                max="16"
                value={form.cpuCores}
                onChange={(event) => updateForm('cpuCores', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Memory</span>
              <select
                value={form.memoryMb}
                onChange={(event) => updateForm('memoryMb', Number(event.target.value))}
              >
                {[1024, 2048, 4096, 8192, 16384, 32768].map((memoryMb) => (
                  <option key={memoryMb} value={memoryMb}>
                    {formatMemory(memoryMb)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Disk GB</span>
              <input
                type="number"
                min="8"
                max="2048"
                value={form.diskGb}
                onChange={(event) => updateForm('diskGb', event.target.value)}
                required
              />
            </label>
          </div>

          <div className="vm-create-grid">
            <label>
              <span>Network bridge</span>
              <input
                type="text"
                value={form.bridge}
                onChange={(event) => updateForm('bridge', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Cloud user</span>
              <input
                type="text"
                value={form.username}
                onChange={(event) => updateForm('username', event.target.value)}
                required
              />
            </label>
          </div>

          <label>
            <span>SSH public key</span>
            <textarea
              value={form.sshPublicKey}
              onChange={(event) => updateForm('sshPublicKey', event.target.value)}
              placeholder="ssh-ed25519 AAAA..."
              rows={3}
              required
            />
          </label>

          <label>
            <span>Description</span>
            <input
              type="text"
              value={form.description}
              onChange={(event) => updateForm('description', event.target.value)}
              placeholder="Short reason for this test VM"
              maxLength={240}
            />
          </label>

          {selectedNode && (
            <div className="vm-template-summary">
              <strong>{selectedNode.templateName}</strong>
              <span>VMID {selectedNode.templateVmId} · {selectedNode.storage} · DHCP</span>
            </div>
          )}

          {submitError && <div className="vm-create-alert error">{submitError}</div>}

          <div className="vm-create-actions">
            <button type="submit" className="primary" disabled={!featureEnabled || submitting}>
              {submitting ? 'Starting...' : 'Create VM'}
            </button>
          </div>
        </form>

        <aside className="vm-create-status">
          <h3>Job status</h3>
          {!job ? (
            <p className="vm-create-muted">No VM creation job started yet.</p>
          ) : (
            <>
              <div className={`vm-job-pill ${job.status}`}>
                {job.status}
              </div>
              <dl className="vm-job-details">
                <div>
                  <dt>Stack</dt>
                  <dd>{job.stackName}</dd>
                </div>
                <div>
                  <dt>VM</dt>
                  <dd>{job.spec?.name}</dd>
                </div>
                <div>
                  <dt>Node</dt>
                  <dd>{job.spec?.node}</dd>
                </div>
                <div>
                  <dt>DHCP IP</dt>
                  <dd>{job.vm?.ipv4 || job.ipStatus || 'pending'}</dd>
                </div>
              </dl>
              {job.error && <div className="vm-create-alert error">{job.error}</div>}
              <pre className="vm-create-logs">
                {(job.logs || []).slice(-80).join('\n')}
              </pre>
            </>
          )}
        </aside>
      </div>
    </section>
  )
}

export default VmCreatePanel
