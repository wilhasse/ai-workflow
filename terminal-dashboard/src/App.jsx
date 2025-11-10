import { useEffect, useMemo, useState } from 'react'
import './App.css'

const STORAGE_KEY = 'terminal-dashboard-shellinabox-v1'
const DEFAULT_PROTOCOL = 'https'
const DEFAULT_HOST = '10.1.0.10'
const DEFAULT_BASE_PORT = 4200
const PORT_STRATEGIES = {
  SEQUENTIAL: 'sequential',
  SINGLE: 'single',
}
const DEFAULT_PORT_STRATEGY = PORT_STRATEGIES.SINGLE

const sanitizeHost = (host) => host.trim().replace(/^https?:\/\//i, '').replace(/\/.*/, '')

const getId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2, 11)
}

const findNextOffset = (terminals) => {
  const used = new Set(terminals.map((terminal) => terminal.offset ?? 0))
  let candidate = 0
  while (used.has(candidate)) {
    candidate += 1
  }
  return candidate
}

const buildUrlForOffset = (project, offset) => {
  const port = project.basePort + offset
  return `${project.protocol}://${project.baseHost}:${port}`
}

const buildTerminalUrl = (project, terminal) => {
  const baseUrl =
    project.portStrategy === PORT_STRATEGIES.SINGLE
      ? `${project.protocol}://${project.baseHost}:${project.basePort}`
      : buildUrlForOffset(project, terminal.offset)
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('projectId', project.id)
    url.searchParams.set('terminalId', terminal.id)
    return url.toString()
  } catch (error) {
    console.warn('Failed to build terminal URL', baseUrl, error)
    return baseUrl
  }
}

const formatEndpointLabel = (url) => {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return url.replace(/^https?:\/\//i, '')
  }
}

const getDefaultProjects = () => [
  {
    id: 'shell-workspace',
    name: 'Shell Workspace',
    description: 'Quick entry to your shellinabox gateway.',
    protocol: DEFAULT_PROTOCOL,
    baseHost: DEFAULT_HOST,
    basePort: DEFAULT_BASE_PORT,
    portStrategy: DEFAULT_PORT_STRATEGY,
    portStrategyLocked: true,
    terminals: [
      {
        id: 'primary-shell',
        name: 'Primary shell',
        offset: 0,
        notes: 'Uses your Linux credentials. Secure HTTPS connection.',
      },
    ],
  },
]

const normalizeProjects = (projects) =>
  projects.map((project) => {
    const protocol = project.protocol === 'http' ? 'http' : DEFAULT_PROTOCOL
    const baseHost = project.baseHost ? sanitizeHost(project.baseHost) : DEFAULT_HOST
    const basePort = Number.isFinite(project.basePort) ? project.basePort : DEFAULT_BASE_PORT
    const portStrategyLocked = project.portStrategyLocked === true
    const requestedStrategy =
      project.portStrategy === PORT_STRATEGIES.SEQUENTIAL
        ? PORT_STRATEGIES.SEQUENTIAL
        : PORT_STRATEGIES.SINGLE
    const portStrategy = portStrategyLocked ? requestedStrategy : DEFAULT_PORT_STRATEGY
    const usedOffsets = new Set()

    const normalizedTerminals = Array.isArray(project.terminals)
      ? project.terminals.map((terminal, index) => {
          let offset = Number.isFinite(terminal.offset) ? terminal.offset : null
          if (offset === null && terminal.url) {
            try {
              const parsed = new URL(terminal.url)
              if (parsed.port) {
                const portNumber = Number.parseInt(parsed.port, 10)
                if (!Number.isNaN(portNumber)) {
                  offset = portNumber - basePort
                }
              }
            } catch (error) {
              console.warn('Could not derive offset from URL', terminal.url, error)
            }
          }

          if (!Number.isFinite(offset)) {
            offset = index
          }

          while (usedOffsets.has(offset)) {
            offset += 1
          }
          usedOffsets.add(offset)

          return {
            id: terminal.id ?? getId(),
            name: terminal.name ?? 'Shell session',
            offset,
            notes: terminal.notes ?? '',
          }
        })
      : []

    return {
      id: project.id ?? getId(),
      name: project.name ?? 'Shell Project',
      description: project.description ?? '',
      protocol,
      baseHost,
      basePort,
      portStrategy,
      portStrategyLocked,
      terminals: normalizedTerminals,
    }
  })

const useProjectsState = () => {
  const loadProjects = () => {
    if (typeof window === 'undefined') {
      return getDefaultProjects()
    }
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return getDefaultProjects()
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return normalizeProjects(parsed)
      }
      return getDefaultProjects()
    } catch (error) {
      console.warn('Failed to parse stored projects, resetting to defaults.', error)
      return getDefaultProjects()
    }
  }

  const [projects, setProjects] = useState(loadProjects)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  }, [projects])

  return [projects, setProjects]
}

function App() {
  const [projects, setProjects] = useProjectsState()
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [activeTerminalId, setActiveTerminalId] = useState(null)
  const [projectForm, setProjectForm] = useState({ name: '', description: '' })
  const [terminalForm, setTerminalForm] = useState({ name: '', notes: '' })
  const [showTerminalForm, setShowTerminalForm] = useState(false)
  const [projectSettingsForm, setProjectSettingsForm] = useState({
    protocol: DEFAULT_PROTOCOL,
    baseHost: DEFAULT_HOST,
    basePort: String(DEFAULT_BASE_PORT),
    portStrategy: DEFAULT_PORT_STRATEGY,
  })

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  )

  const activeTerminal = useMemo(() => {
    if (!activeProject) {
      return null
    }
    return activeProject.terminals.find((terminal) => terminal.id === activeTerminalId) ?? null
  }, [activeProject, activeTerminalId])

  useEffect(() => {
    if (!projects.length) {
      if (activeProjectId !== null) {
        setActiveProjectId(null)
      }
      return
    }
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const requestedId = params?.get('project') ?? null
    if (requestedId && projects.some((project) => project.id === requestedId)) {
      if (activeProjectId !== requestedId) {
        setActiveProjectId(requestedId)
      }
      return
    }
    const fallbackId = projects[0].id
    if (activeProjectId !== fallbackId) {
      setActiveProjectId(fallbackId)
    }
  }, [projects, activeProjectId])

  useEffect(() => {
    if (typeof window === 'undefined' || !activeProject) {
      return
    }
    const params = new URLSearchParams(window.location.search)
    const requestedTerminalId = params.get('terminal')
    if (!requestedTerminalId) {
      return
    }
    const terminalExists = activeProject.terminals.some((terminal) => terminal.id === requestedTerminalId)
    if (terminalExists) {
      setActiveTerminalId(requestedTerminalId)
    }
  }, [activeProject])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const params = new URLSearchParams(window.location.search)
    if (activeProjectId) {
      params.set('project', activeProjectId)
    } else {
      params.delete('project')
    }
    if (activeTerminalId) {
      params.set('terminal', activeTerminalId)
    } else {
      params.delete('terminal')
    }
    const query = params.toString()
    const newUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname
    window.history.replaceState(null, '', newUrl)
  }, [activeProjectId, activeTerminalId])

  useEffect(() => {
    if (!activeProject || !activeProject.terminals.length) {
      setActiveTerminalId(null)
      return
    }
    const hasActiveTerminal = activeProject.terminals.some((terminal) => terminal.id === activeTerminalId)
    if (!hasActiveTerminal) {
      setActiveTerminalId(activeProject.terminals[0].id)
    }
  }, [activeProject, activeTerminalId])

  useEffect(() => {
    if (activeProject) {
      setProjectSettingsForm({
        protocol: activeProject.protocol,
        baseHost: activeProject.baseHost,
        basePort: String(activeProject.basePort),
        portStrategy: activeProject.portStrategy,
      })
    } else {
      setProjectSettingsForm({
        protocol: DEFAULT_PROTOCOL,
        baseHost: DEFAULT_HOST,
        basePort: String(DEFAULT_BASE_PORT),
        portStrategy: DEFAULT_PORT_STRATEGY,
      })
    }
  }, [activeProject])

  const handleSelectProject = (projectId) => {
    setActiveProjectId(projectId)
    setShowTerminalForm(false)
  }

  const handleRemoveProject = (projectId) => {
    setProjects((prev) => prev.filter((project) => project.id !== projectId))
    if (activeProjectId === projectId) {
      setActiveProjectId(null)
      setActiveTerminalId(null)
      setShowTerminalForm(false)
    }
  }

  const handleProjectSubmit = (event) => {
    event.preventDefault()
    const name = projectForm.name.trim()
    if (!name) {
      return
    }
    const newProject = {
      id: getId(),
      name,
      description: projectForm.description.trim(),
      protocol: DEFAULT_PROTOCOL,
      baseHost: DEFAULT_HOST,
      basePort: DEFAULT_BASE_PORT,
      portStrategy: DEFAULT_PORT_STRATEGY,
      portStrategyLocked: false,
      terminals: [],
    }
    setProjects((prev) => [...prev, newProject])
    setProjectForm({ name: '', description: '' })
    setActiveProjectId(newProject.id)
    setActiveTerminalId(null)
    setShowTerminalForm(false)
  }

  const handleProjectSettingsSubmit = (event) => {
    event.preventDefault()
    if (!activeProject) {
      return
    }
    const protocol = projectSettingsForm.protocol === 'http' ? 'http' : DEFAULT_PROTOCOL
    const baseHost = sanitizeHost(projectSettingsForm.baseHost || DEFAULT_HOST) || DEFAULT_HOST
    const basePortNumber = Number.parseInt(projectSettingsForm.basePort, 10)
    if (!Number.isFinite(basePortNumber) || basePortNumber <= 0) {
      return
    }
    const portStrategy =
      projectSettingsForm.portStrategy === PORT_STRATEGIES.SINGLE
        ? PORT_STRATEGIES.SINGLE
        : PORT_STRATEGIES.SEQUENTIAL
    setProjects((prev) =>
      prev.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              protocol,
              baseHost,
              basePort: basePortNumber,
              portStrategy,
              portStrategyLocked: true,
            }
          : project,
      ),
    )
  }

  const handleTerminalSubmit = (event) => {
    event.preventDefault()
    if (!activeProject) {
      return
    }
    const name = terminalForm.name.trim()
    if (!name) {
      return
    }
    const offset = findNextOffset(activeProject.terminals)
    const terminal = {
      id: getId(),
      name,
      offset,
      notes: terminalForm.notes.trim(),
    }
    setProjects((prev) =>
      prev.map((project) =>
        project.id === activeProject.id
          ? { ...project, terminals: [...project.terminals, terminal] }
          : project,
      ),
    )
    setTerminalForm({ name: '', notes: '' })
    setShowTerminalForm(false)
    setActiveTerminalId(terminal.id)
  }

  const handleRemoveTerminal = (terminalId) => {
    if (!activeProject) {
      return
    }
    const remainingTerminals = activeProject.terminals.filter((terminal) => terminal.id !== terminalId)
    setProjects((prev) =>
      prev.map((project) =>
        project.id === activeProject.id
          ? { ...project, terminals: remainingTerminals }
          : project,
      ),
    )
    if (activeTerminalId === terminalId) {
      setActiveTerminalId(remainingTerminals[0]?.id ?? null)
    }
  }

  const handleOpenProjectTab = () => {
    if (typeof window === 'undefined' || !activeProjectId) {
      return
    }
    const url = `${window.location.origin}${window.location.pathname}?project=${activeProjectId}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const nextTerminalUrl = activeProject
    ? buildUrlForOffset(
        activeProject,
        activeProject.portStrategy === PORT_STRATEGIES.SINGLE
          ? 0
          : findNextOffset(activeProject.terminals),
      )
    : null

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Shellinabox Control Center</h1>
          <p className="subtitle">Keep each project in its own browser tab with dedicated shell access.</p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={handleOpenProjectTab}
          disabled={!activeProjectId}
        >
          Open project in new browser tab
        </button>
      </header>

      <nav className="project-tabs" role="tablist">
        {projects.map((project) => {
          const isActive = project.id === activeProjectId
          return (
            <button
              key={project.id}
              role="tab"
              aria-selected={isActive}
              className={`project-tab ${isActive ? 'active' : ''}`}
              onClick={() => handleSelectProject(project.id)}
            >
              <span>{project.name}</span>
              {projects.length > 1 && (
                <span
                  className="remove-project"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleRemoveProject(project.id)
                  }}
                  title="Remove project"
                >
                  ×
                </span>
              )}
            </button>
          )
        })}
        <form onSubmit={handleProjectSubmit} className="project-form">
          <input
            type="text"
            placeholder="New project"
            value={projectForm.name}
            onChange={(event) =>
              setProjectForm((prev) => ({ ...prev, name: event.target.value }))
            }
            aria-label="New project name"
          />
          <input
            type="text"
            placeholder="Description"
            value={projectForm.description}
            onChange={(event) =>
              setProjectForm((prev) => ({ ...prev, description: event.target.value }))
            }
            aria-label="New project description"
          />
          <button type="submit" className="primary">Add</button>
        </form>
      </nav>

      <main className="main-panel">
        {activeProject ? (
          <>
            <section className="project-summary">
              <div>
                <h2>{activeProject.name}</h2>
                {activeProject.description && <p>{activeProject.description}</p>}
              </div>
              <span className="badge">{activeProject.terminals.length} terminals</span>
            </section>

            <section className="connection-settings">
              <form onSubmit={handleProjectSettingsSubmit}>
                <div className="fields">
                  <label>
                    Protocol
                    <select
                      value={projectSettingsForm.protocol}
                      onChange={(event) =>
                        setProjectSettingsForm((prev) => ({
                          ...prev,
                          protocol: event.target.value,
                        }))
                      }
                    >
                      <option value="https">https</option>
                      <option value="http">http</option>
                    </select>
                  </label>
                  <label>
                    Host
                    <input
                      type="text"
                      value={projectSettingsForm.baseHost}
                      onChange={(event) =>
                        setProjectSettingsForm((prev) => ({
                          ...prev,
                          baseHost: event.target.value,
                        }))
                      }
                      placeholder="10.1.0.10"
                    />
                  </label>
                  <label>
                    Base port
                    <input
                      type="number"
                      min="1"
                      value={projectSettingsForm.basePort}
                      onChange={(event) =>
                        setProjectSettingsForm((prev) => ({
                          ...prev,
                          basePort: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Port strategy
                    <select
                      value={projectSettingsForm.portStrategy}
                      onChange={(event) =>
                        setProjectSettingsForm((prev) => ({
                          ...prev,
                          portStrategy: event.target.value,
                        }))
                      }
                    >
                      <option value={PORT_STRATEGIES.SEQUENTIAL}>Increment per terminal (4200, 4201, …)</option>
                      <option value={PORT_STRATEGIES.SINGLE}>Reuse base port for every terminal</option>
                    </select>
                  </label>
                </div>
                <div className="form-actions">
                  <button type="submit" className="secondary">Save connection</button>
                </div>
              </form>
              {nextTerminalUrl && (
                <p className="next-terminal-hint">
                  {activeProject.portStrategy === PORT_STRATEGIES.SINGLE ? (
                    <>
                      All terminals reuse <code>{nextTerminalUrl}</code>. Use tmux/screen server-side if you need persistent shells.
                    </>
                  ) : (
                    <>
                      Next terminal will map to <code>{nextTerminalUrl}</code>
                    </>
                  )}
                </p>
              )}
            </section>

            <section className="terminal-tabs" role="tablist">
              {activeProject.terminals.map((terminal) => {
                const isActive = terminal.id === activeTerminalId
                const terminalUrl = buildTerminalUrl(activeProject, terminal)
                return (
                  <button
                    key={terminal.id}
                    role="tab"
                    aria-selected={isActive}
                    className={`terminal-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTerminalId(terminal.id)}
                  >
                    <span>{terminal.name}</span>
                    <small>{formatEndpointLabel(terminalUrl)}</small>
                  </button>
                )
              })}
              <button
                type="button"
                className="terminal-tab add"
                onClick={() => setShowTerminalForm((prev) => !prev)}
              >
                + Add terminal
              </button>
            </section>

            {showTerminalForm && (
              <section className="terminal-form">
                <form onSubmit={handleTerminalSubmit}>
                  <div className="field-row">
                    <label>
                      Name
                      <input
                        type="text"
                        value={terminalForm.name}
                        onChange={(event) =>
                          setTerminalForm((prev) => ({ ...prev, name: event.target.value }))
                        }
                        required
                      />
                    </label>
                  </div>
                  <label>
                    Notes (optional)
                    <input
                      type="text"
                      value={terminalForm.notes}
                      onChange={(event) =>
                        setTerminalForm((prev) => ({ ...prev, notes: event.target.value }))
                      }
                      placeholder="Credentials, commands, reminders"
                    />
                  </label>
                  <p className="next-terminal-hint">
                    {activeProject.portStrategy === PORT_STRATEGIES.SINGLE ? (
                      <>
                        This terminal will reuse <code>{nextTerminalUrl}</code>
                      </>
                    ) : (
                      <>
                        This terminal will map to <code>{nextTerminalUrl}</code>
                      </>
                    )}
                  </p>
                  <div className="form-actions">
                    <button type="submit" className="primary">Save terminal</button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setShowTerminalForm(false)
                        setTerminalForm({ name: '', notes: '' })
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </section>
            )}

            {activeTerminal ? (
              <section className="terminal-view">
                <header className="terminal-view-header">
                  <div>
                    <h3>{activeTerminal.name}</h3>
                    {activeTerminal.notes && <p>{activeTerminal.notes}</p>}
                  </div>
                  <div className="terminal-actions">
                    <div className="terminal-endpoint">
                      <span>Endpoint</span>
                      <code>{buildTerminalUrl(activeProject, activeTerminal)}</code>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        window.open(
                          buildTerminalUrl(activeProject, activeTerminal),
                          '_blank',
                          'noopener,noreferrer',
                        )
                      }
                    >
                      Open in new tab
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => handleRemoveTerminal(activeTerminal.id)}
                    >
                      Remove
                    </button>
                  </div>
                </header>
                <div className="terminal-frame">
                  {activeProject.terminals.map((terminal) => {
                    const terminalUrl = buildTerminalUrl(activeProject, terminal)
                    const isVisible = terminal.id === activeTerminalId
                    return (
                      <iframe
                        key={terminal.id}
                        src={terminalUrl}
                        title={terminal.name}
                        className={`terminal-frame-iframe ${isVisible ? 'active' : 'inactive'}`}
                        allow="clipboard-read; clipboard-write"
                        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                      />
                    )
                  })}
                </div>
              </section>
            ) : (
              <div className="empty-state">
                <p>Select a terminal tab or add one to start.</p>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Create a project to start organizing shellinabox sessions.</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
