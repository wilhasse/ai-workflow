import { useMemo, useState } from 'react'

const formatTokens = (usage) => {
  const value = Number(usage?.total?.totalTokens || usage?.last?.totalTokens || 0)
  return value ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—'
}

export default function ComparisonPanel({ presets, comparisons, defaultCwd, busy, onStart }) {
  const [cwd, setCwd] = useState(defaultCwd || '')
  const [prompt, setPrompt] = useState('')
  const [selectedPresets, setSelectedPresets] = useState(['default', 'k3', 'qwen'])
  const latest = useMemo(
    () => [...comparisons].sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))[0],
    [comparisons],
  )

  const togglePreset = (presetId) => {
    setSelectedPresets((current) => current.includes(presetId)
      ? current.filter((id) => id !== presetId)
      : [...current, presetId])
  }

  const submit = async (event) => {
    event.preventDefault()
    await onStart({ cwd, prompt, presets: selectedPresets })
  }

  return (
    <section className="ab-panel ab-comparison">
      <header className="ab-panel-header">
        <div>
          <h3>Read-only model comparison</h3>
          <p>The same prompt and workspace run in isolated ephemeral threads. Writes and approvals are disabled.</p>
        </div>
        {latest && <span className={`ab-status ${latest.status}`}>{latest.status}</span>}
      </header>

      <form className="ab-compare-form" onSubmit={submit}>
        <input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="Workspace path (blank uses ai-workflow)"
        />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Prompt to run identically across models"
          rows={3}
          required
        />
        <div className="ab-preset-checks">
          {presets.map((preset) => (
            <label key={preset.id}>
              <input
                type="checkbox"
                checked={selectedPresets.includes(preset.id)}
                onChange={() => togglePreset(preset.id)}
              />
              {preset.label}
            </label>
          ))}
        </div>
        <button className="primary" type="submit" disabled={busy || selectedPresets.length < 2}>
          {busy ? 'Starting comparison…' : 'Compare selected models'}
        </button>
      </form>

      {latest && (
        <div className="ab-compare-grid">
          {latest.entries.map((entry) => (
            <article className="ab-compare-result" key={entry.preset}>
              <header>
                <strong>{presets.find((preset) => preset.id === entry.preset)?.label || entry.preset}</strong>
                <span className={`ab-status ${entry.status}`}>{entry.status}</span>
              </header>
              <div className="ab-runtime-row">
                {entry.model && <span>{entry.model}</span>}
                {entry.modelProvider && <span>{entry.modelProvider}</span>}
                {entry.reasoningEffort && <span>{entry.reasoningEffort}</span>}
              </div>
              <div className="ab-usage-row">
                <span>{formatTokens(entry.tokenUsage)} tokens</span>
                {entry.durationMs != null && <span>{(entry.durationMs / 1000).toFixed(1)}s</span>}
              </div>
              {entry.error && <div className="ab-error">{entry.error}</div>}
              <pre>{entry.output || (entry.status === 'running' ? 'Waiting for response…' : 'No output yet')}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
