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
    description: '',
    protocol: DEFAULT_PROTOCOL,
    baseHost: DEFAULT_HOST,
    basePort: DEFAULT_BASE_PORT,
    portStrategy: DEFAULT_PORT_STRATEGY,
    portStrategyLocked: true,
    terminals: [],
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
  const [showSettings, setShowSettings] = useState(false)
  const [projectForm, setProjectForm] = useState({ name: '', description: '' })
  const [terminalForm, setTerminalForm] = useState({ name: '', notes: '' })
  const [showTerminalForm, setShowTerminalForm] = useState(false)

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
    // Only set fallback if no active project or active project doesn't exist
    if (!activeProjectId || !projects.some((project) => project.id === activeProjectId)) {
      setActiveProjectId(projects[0].id)
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

  const handleSelectProject = (projectId) => {
    setActiveProjectId(projectId)
    setShowTerminalForm(false)
    setShowSettings(false)
  }

  const handleRemoveProject = (projectId) => {
    if (!confirm('Delete this project and all its terminals?')) {
      return
    }
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
    if (!confirm('Delete this terminal?')) {
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

  return (
    <div className="app-shell">
      <header className="app-header-compact">
        <div className="header-left">
          <h1>AI Workflow</h1>
          {projects.length > 0 && (
            <div className="project-selector">
              <select
                value={activeProjectId || ''}
                onChange={(e) => handleSelectProject(e.target.value)}
                className="project-select"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                    {project.terminals.length > 0 && ` (${project.terminals.length} terminals)`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            ⚙️
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={handleOpenProjectTab}
            disabled={!activeProjectId}
            title="Open in new tab"
          >
            🗗
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="settings-panel">
          <div className="settings-content">
            <div className="settings-header">
              <h2>Projects</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <div className="project-list">
              {projects.map((project) => {
                const isActive = project.id === activeProjectId
                return (
                  <div
                    key={project.id}
                    className={`project-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleSelectProject(project.id)}
                  >
                    <div className="project-item-content">
                      <strong>{project.name}</strong>
                      {project.description && <small>{project.description}</small>}
                    </div>
                    {projects.length > 1 && (
                      <button
                        className="remove-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemoveProject(project.id)
                        }}
                        title="Delete project"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <form onSubmit={handleProjectSubmit} className="settings-form">
              <h3>Add Project</h3>
              <input
                type="text"
                placeholder="Project name"
                value={projectForm.name}
                onChange={(e) => setProjectForm((prev) => ({ ...prev, name: e.target.value }))}
                required
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={projectForm.description}
                onChange={(e) => setProjectForm((prev) => ({ ...prev, description: e.target.value }))}
              />
              <button type="submit" className="primary">Create Project</button>
            </form>
          </div>
        </div>
      )}

      <main className="main-panel-compact">
        {activeProject ? (
          <>
            <section className="terminal-tabs-compact">
              {activeProject.terminals.map((terminal) => {
                const isActive = terminal.id === activeTerminalId
                return (
                  <button
                    key={terminal.id}
                    className={`terminal-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTerminalId(terminal.id)}
                    title={terminal.notes || terminal.name}
                  >
                    {terminal.name}
                    <span
                      className="remove-icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveTerminal(terminal.id)
                      }}
                      title="Remove terminal"
                    >
                      ✕
                    </span>
                  </button>
                )
              })}
              <button
                type="button"
                className="terminal-tab add"
                onClick={() => setShowTerminalForm(!showTerminalForm)}
                title="Add terminal"
              >
                +
              </button>
            </section>

            {showTerminalForm && (
              <section className="terminal-form-compact">
                <form onSubmit={handleTerminalSubmit}>
                  <input
                    type="text"
                    placeholder="Terminal name"
                    value={terminalForm.name}
                    onChange={(e) => setTerminalForm((prev) => ({ ...prev, name: e.target.value }))}
                    required
                    autoFocus
                  />
                  <input
                    type="text"
                    placeholder="Notes (optional)"
                    value={terminalForm.notes}
                    onChange={(e) => setTerminalForm((prev) => ({ ...prev, notes: e.target.value }))}
                  />
                  <div className="form-actions-inline">
                    <button type="submit" className="primary">Add</button>
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
              <section className="terminal-view-fullscreen">
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
                <p>Click + to add a terminal</p>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Open settings (⚙️) to create a project</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
