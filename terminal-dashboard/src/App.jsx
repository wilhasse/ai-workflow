import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './App.css'

const STORAGE_KEY = 'terminal-dashboard-xterm-v1'
const FONT_SIZE_STORAGE_KEY = 'terminal-dashboard-font-size'
const PROJECT_VIEW_MODE_STORAGE_KEY = 'terminal-dashboard-project-view-mode'
const AUTH_STORAGE_KEY = 'terminal-dashboard-auth-token'
const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 22]
const DEFAULT_FONT_SIZE = 16
const PROJECT_VIEW_MODES = {
  DROPDOWN: 'dropdown',
  TABS: 'tabs',
}

const detectDefaultProtocol = () => {
  if (typeof window !== 'undefined' && window.location?.protocol) {
    return window.location.protocol === 'http:' ? 'http' : 'https'
  }
  return 'https'
}

const detectDefaultHost = () => {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return window.location.hostname
  }
  return '10.1.0.10'
}

const DEFAULT_PROTOCOL = detectDefaultProtocol()
const DEFAULT_HOST = detectDefaultHost()
const DEFAULT_BASE_PORT = 5001

const detectApiBase = () => {
  if (typeof window === 'undefined') {
    return `http://localhost:${DEFAULT_BASE_PORT}`
  }
  const { protocol, hostname, port } = window.location
  const isDevPort = port && port !== '80' && port !== '443'
  if (isDevPort) {
    return `${protocol}//${hostname}:${DEFAULT_BASE_PORT}`
  }
  const portSuffix = port ? `:${port}` : ''
  return `${protocol}//${hostname}${portSuffix}/api`
}

const API_BASE = detectApiBase()
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

const apiFetch = async (path, { method = 'GET', body = null, token = null } = {}) => {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  const normalizedPath = path.startsWith('http')
    ? path
    : `${base}${path.startsWith('/') ? path : `/${path}`}`
  const headers = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const options = {
    method,
    headers,
  }
  if (body) {
    options.body = JSON.stringify(body)
  }
  const response = await fetch(normalizedPath, options)
  if (response.status === 204) {
    return {}
  }
  let payload = null
  try {
    const text = await response.text()
    payload = text ? JSON.parse(text) : {}
  } catch (error) {
    console.warn('Failed to parse API response', error)
  }
  if (!response.ok) {
    const message = payload?.error ?? `Request failed (${response.status})`
    throw new Error(message)
  }
  return payload ?? {}
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

const getTerminalBaseUrl = (project, terminal) => {
  if (project.portStrategy === PORT_STRATEGIES.SINGLE) {
    return `${project.protocol}://${project.baseHost}:${project.basePort}`
  }
  const offset = Number.isFinite(terminal.offset) ? terminal.offset : 0
  return buildUrlForOffset(project, offset)
}

const buildTerminalSocketUrl = (project, terminal) => {
  try {
    // Check if we're connecting to the same host (Docker deployment via nginx)
    const currentHost = window.location.hostname
    const targetHost = project.baseHost

    // If connecting to same host or localhost, use nginx proxy (no port)
    if (currentHost === targetHost || targetHost === 'localhost' || targetHost === '127.0.0.1') {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const port = window.location.port ? `:${window.location.port}` : ''
      const url = `${protocol}//${currentHost}${port}/ws/sessions/${terminal.id}?projectId=${project.id}`
      return url
    }

    // Otherwise use the configured host:port (for external/multi-host setups)
    const baseUrl = new URL(getTerminalBaseUrl(project, terminal))
    baseUrl.protocol = project.protocol === 'http' ? 'ws:' : 'wss:'
    baseUrl.pathname = `/ws/sessions/${terminal.id}`
    baseUrl.search = ''
    baseUrl.searchParams.set('projectId', project.id)
    return baseUrl.toString()
  } catch (error) {
    console.warn('Failed to build socket URL', error.message)
    return ''
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
    const storedHost = project.baseHost ? sanitizeHost(project.baseHost) : DEFAULT_HOST
    const baseHost =
      storedHost === '10.1.0.10' && DEFAULT_HOST !== '10.1.0.10' ? DEFAULT_HOST : storedHost
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

const loadStoredProjects = () => {
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

const detectSecureContext = () => {
  if (typeof window === 'undefined') {
    return false
  }
  if (window.isSecureContext) {
    return true
  }
  const protocol = window.location.protocol
  if (protocol === 'https:') {
    return true
  }
  const hostname = window.location.hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function ConfirmDialog({ isOpen, title, message, onConfirm, onCancel }) {
  if (!isOpen) {
    return null
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="dialog-title">{title}</h3>}
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dialog-btn primary" onClick={onConfirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

function TerminalViewer({ wsUrl, fontSize, onBridgeReady }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const socketRef = useRef(null)
  const fontSizeRef = useRef(fontSize)
  const [connectionState, setConnectionState] = useState({
    status: 'connecting',
    message: 'Connecting…',
  })

  useEffect(() => {
    fontSizeRef.current = fontSize
  }, [fontSize])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return () => {}
    }
    if (!wsUrl) {
      setConnectionState({ status: 'error', message: 'Missing connection target' })
      return () => {}
    }
    const container = containerRef.current
    if (!container) {
      return () => {}
    }

    setConnectionState({ status: 'connecting', message: 'Connecting…' })
    const term = new Terminal({
      cursorBlink: true,
      allowTransparency: true,
      convertEol: true,
      fontSize: fontSizeRef.current,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#030712',
        foreground: '#f8fafc',
        cursor: '#38bdf8',
      },
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(container)
    fitAddon.fit()
    term.focus()
    termRef.current = term
    fitAddonRef.current = fitAddon

    let socket
    try {
      socket = new window.WebSocket(wsUrl)
      socketRef.current = socket
    } catch (error) {
      console.warn('Failed to open websocket', error)
      term.dispose()
      setConnectionState({ status: 'error', message: 'Invalid connection URL' })
      return () => {}
    }

    const sendMessage = (payload) => {
      if (socket?.readyState === window.WebSocket.OPEN) {
        socket.send(JSON.stringify(payload))
      }
    }

    const pushResize = () => {
      fitAddon.fit()
      sendMessage({ type: 'resize', cols: term.cols, rows: term.rows })
    }

    socket.addEventListener('open', () => {
      setConnectionState({ status: 'connected', message: 'Connected' })
      pushResize()
    })

    socket.addEventListener('close', () => {
      setConnectionState((previous) =>
        previous.status === 'error' ? previous : { status: 'closed', message: 'Session closed' },
      )
    })

    socket.addEventListener('error', () => {
      setConnectionState({ status: 'error', message: 'Connection error' })
    })

    socket.addEventListener('message', (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === 'data' && typeof payload.payload === 'string') {
        term.write(payload.payload)
        return
      }
      if (payload.type === 'ready') {
        setConnectionState({ status: 'connected', message: 'Session ready' })
        return
      }
      if (payload.type === 'exit') {
        setConnectionState({ status: 'closed', message: 'Detached from tmux session' })
        socket.close()
        return
      }
      if (payload.type === 'error') {
        setConnectionState({ status: 'error', message: payload.message ?? 'Bridge error' })
        socket.close()
      }
    })

    const dataDisposable = term.onData((chunk) => {
      sendMessage({ type: 'input', payload: chunk })
    })

    let cleanupResize = () => {}
    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      const observer = new window.ResizeObserver(() => {
        pushResize()
      })
      observer.observe(container)
      cleanupResize = () => observer.disconnect()
    } else {
      const handleResize = () => pushResize()
      window.addEventListener('resize', handleResize)
      cleanupResize = () => window.removeEventListener('resize', handleResize)
    }

    return () => {
      dataDisposable.dispose()
      cleanupResize()
      if (
        socket.readyState === window.WebSocket.OPEN ||
        socket.readyState === window.WebSocket.CONNECTING
      ) {
        socket.close()
      }
      socketRef.current = null
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [wsUrl])

  useEffect(() => {
    if (typeof onBridgeReady !== 'function') {
      return undefined
    }
    const bridge = {
      sendInput: (payload) => {
        if (!payload || typeof payload !== 'string') {
          return
        }
        const target = socketRef.current
        if (target && target.readyState === window.WebSocket.OPEN) {
          target.send(
            JSON.stringify({
              type: 'input',
              payload,
            }),
          )
        }
      },
    }
    onBridgeReady(bridge)
    return () => {
      onBridgeReady(null)
    }
  }, [onBridgeReady, wsUrl])

  useEffect(() => {
    const term = termRef.current
    if (!term) {
      return
    }
    if (term.options) {
      term.options.fontSize = fontSize
    }
    if (typeof term.setOption === 'function') {
      term.setOption('fontSize', fontSize)
    }
    if (typeof term.refresh === 'function') {
      term.refresh(0, term.rows - 1)
    }
    fitAddonRef.current?.fit()
  }, [fontSize])

  return (
    <div className="terminal-frame">
      <div ref={containerRef} className="terminal-surface" />
      <div className={`terminal-status terminal-status-${connectionState.status}`}>
        <span className="terminal-status-dot" />
        {connectionState.message}
      </div>
    </div>
  )
}

function App() {
  const [projects, setProjects] = useState(() => loadStoredProjects())
  const [authToken, setAuthToken] = useState(() => {
    if (typeof window === 'undefined') {
      return ''
    }
    return window.localStorage.getItem(AUTH_STORAGE_KEY) ?? ''
  })
  const guestProjectsRef = useRef(null)
  if (guestProjectsRef.current === null) {
    guestProjectsRef.current = projects
  }
  const [currentUser, setCurrentUser] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({ username: '', password: '' })
  const [authStatus, setAuthStatus] = useState(() => (authToken ? 'checking' : 'loggedOut'))
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [isSyncingProjects, setIsSyncingProjects] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [projectSyncNonce, setProjectSyncNonce] = useState(0)
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [activeTerminalId, setActiveTerminalId] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [projectForm, setProjectForm] = useState({ name: '', description: '' })
  const [terminalForm, setTerminalForm] = useState({ name: '', notes: '' })
  const [showTerminalForm, setShowTerminalForm] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, message: '', onConfirm: null })
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_FONT_SIZE
    }
    const stored = Number.parseInt(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY) ?? '', 10)
    return FONT_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_FONT_SIZE
  })
  const [projectViewMode, setProjectViewMode] = useState(() => {
    if (typeof window === 'undefined') {
      return PROJECT_VIEW_MODES.DROPDOWN
    }
    const stored = window.localStorage.getItem(PROJECT_VIEW_MODE_STORAGE_KEY)
    return stored === PROJECT_VIEW_MODES.TABS ? PROJECT_VIEW_MODES.TABS : PROJECT_VIEW_MODES.DROPDOWN
  })
  const [terminalBridge, setTerminalBridge] = useState(null)
  const [showVoicePanel, setShowVoicePanel] = useState(false)
  const [isSecureContext, setIsSecureContext] = useState(() => detectSecureContext())
  const [voiceLanguage, setVoiceLanguage] = useState('')
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('Idle')
  const [voiceError, setVoiceError] = useState('')
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voicePending, setVoicePending] = useState(false)
  const voiceRecorderRef = useRef(null)
  const voiceStreamRef = useRef(null)
  const voiceChunksRef = useRef([])

  const cleanupVoiceResources = useCallback(() => {
    if (voiceRecorderRef.current && voiceRecorderRef.current.state !== 'inactive') {
      try {
        voiceRecorderRef.current.stop()
      } catch (error) {
        console.warn('Failed to stop recorder', error)
      }
    }
    voiceRecorderRef.current = null
    if (voiceStreamRef.current) {
      voiceStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch (error) {
          console.warn('Failed to stop track', error)
        }
      })
    }
    voiceStreamRef.current = null
    voiceChunksRef.current = []
    setVoiceRecording(false)
  }, [])

  useEffect(() => {
    setIsSecureContext(detectSecureContext())
  }, [])

  useEffect(() => () => {
    cleanupVoiceResources()
  }, [cleanupVoiceResources])

  const sendVoiceFileForTranscription = useCallback(
    async (file) => {
      if (!file) {
        return
      }
      setVoicePending(true)
      setVoiceStatus(`Uploading ${file.name}…`)
      setVoiceError('')
      const form = new FormData()
      form.append('file', file)
      if (voiceLanguage) {
        form.append('language', voiceLanguage)
      }
      try {
        const response = await fetch('/api/whisper/transcribe', {
          method: 'POST',
          body: form,
        })
        if (!response.ok) {
          const message = await response.text()
          throw new Error(message || `HTTP ${response.status}`)
        }
        const payload = await response.json()
        const transcript = typeof payload.text === 'string' ? payload.text.trim() : ''
        setVoiceTranscript(transcript)
        setVoiceStatus('Transcription complete')
      } catch (error) {
        console.error(error)
        setVoiceError(error.message || 'Failed to transcribe audio.')
        setVoiceStatus('Error')
        setVoiceTranscript('')
      } finally {
        setVoicePending(false)
      }
    },
    [voiceLanguage],
  )

  const handleVoiceRecordingStart = async () => {
    if (!isSecureContext) {
      setVoiceError('Microphone access requires HTTPS or localhost.')
      return
    }
    if (voiceRecording || voicePending) {
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError('Microphone API is unavailable in this browser.')
      return
    }
    try {
      setVoiceError('')
      setVoiceTranscript('')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      voiceStreamRef.current = stream
      if (typeof window.MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not supported in this browser.')
      }
      const recorder = new window.MediaRecorder(stream, { mimeType: 'audio/webm' })
      voiceChunksRef.current = []
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data)
        }
      })
      recorder.addEventListener('start', () => {
        setVoiceRecording(true)
        setVoiceStatus('Recording…')
      })
      recorder.addEventListener('stop', async () => {
        setVoiceRecording(false)
        const blob = new Blob(voiceChunksRef.current, { type: 'audio/webm' })
        cleanupVoiceResources()
        if (!blob.size) {
          setVoiceError('No audio captured.')
          setVoiceStatus('Idle')
          return
        }
        const syntheticFile = new File([blob], 'voice-input.webm', { type: 'audio/webm' })
        await sendVoiceFileForTranscription(syntheticFile)
      })
      recorder.start()
      voiceRecorderRef.current = recorder
    } catch (error) {
      console.error(error)
      setVoiceError('Unable to access microphone. Grant permission and try again.')
      cleanupVoiceResources()
    }
  }

  const handleVoiceRecordingStop = () => {
    if (voiceRecorderRef.current && voiceRecorderRef.current.state !== 'inactive') {
      voiceRecorderRef.current.stop()
    } else {
      cleanupVoiceResources()
    }
  }

  const handleVoiceFileSelection = async (file) => {
    if (!file) {
      return
    }
    cleanupVoiceResources()
    await sendVoiceFileForTranscription(file)
  }

  const handleVoiceFileInputChange = async (event) => {
    const file = event.target.files?.[0]
    if (file) {
      await handleVoiceFileSelection(file)
      event.target.value = ''
    }
  }

  const handleCopyTranscript = async () => {
    if (!voiceTranscript.trim()) {
      setVoiceError('No transcript to copy.')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setVoiceError('Clipboard access is unavailable in this browser.')
      return
    }
    try {
      await navigator.clipboard.writeText(voiceTranscript)
      setVoiceStatus('Copied to clipboard')
      setVoiceError('')
    } catch (error) {
      console.error(error)
      setVoiceError('Failed to copy transcript.')
    }
  }

  const handleSendTranscriptToTerminal = () => {
    const text = voiceTranscript.trim()
    if (!text) {
      setVoiceError('No transcript available.')
      return
    }
    if (!terminalBridge) {
      setVoiceError('Select a terminal before sending the transcript.')
      return
    }
    terminalBridge.sendInput(`${text}\n`)
    setVoiceStatus('Sent to terminal')
    setVoiceTranscript('')
    setVoiceError('')
  }

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    if (authToken) {
      window.localStorage.setItem(AUTH_STORAGE_KEY, authToken)
    } else {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
    }
  }, [authToken])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(terminalFontSize))
  }, [terminalFontSize])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    window.localStorage.setItem(PROJECT_VIEW_MODE_STORAGE_KEY, projectViewMode)
  }, [projectViewMode])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    if (!currentUser) {
      guestProjectsRef.current = projects
    }
  }, [projects, currentUser])

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null)
      setAuthStatus('loggedOut')
      setSyncError('')
      setIsSyncingProjects(false)
      return
    }
    let cancelled = false
    const hadUser = Boolean(currentUser)
    if (!hadUser) {
      setAuthStatus('checking')
    }
    ;(async () => {
      try {
        const data = await apiFetch('/me', { token: authToken })
        if (cancelled) {
          return
        }
        if (data.user) {
          setCurrentUser(data.user)
          if (Array.isArray(data.user.projects)) {
            setProjects(normalizeProjects(data.user.projects))
          } else {
            setProjects(getDefaultProjects())
          }
          setAuthStatus('authenticated')
        } else {
          throw new Error('Invalid response')
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Session validation failed', error.message)
          setAuthToken('')
          setCurrentUser(null)
          setAuthStatus('loggedOut')
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken])

  useEffect(() => {
    if (!authToken || !currentUser) {
      setIsSyncingProjects(false)
      return
    }
    let ignore = false
    const syncProjects = async () => {
      setIsSyncingProjects(true)
      setSyncError('')
      try {
        await apiFetch('/me/projects', {
          method: 'PUT',
          body: { projects },
          token: authToken,
        })
        if (!ignore) {
          setIsSyncingProjects(false)
          setSyncError('')
        }
      } catch (error) {
        if (!ignore) {
          setIsSyncingProjects(false)
          setSyncError(error.message ?? 'Failed to sync projects')
        }
      }
    }
    syncProjects()
    return () => {
      ignore = true
    }
  }, [projects, authToken, currentUser, projectSyncNonce])

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
    if (!activeTerminal) {
      setTerminalBridge(null)
    }
  }, [activeTerminal])

  const activeConnection = useMemo(() => {
    if (!activeProject || !activeTerminal) {
      return null
    }
    const baseUrl = getTerminalBaseUrl(activeProject, activeTerminal)
    return {
      wsUrl: buildTerminalSocketUrl(activeProject, activeTerminal),
      endpointLabel: formatEndpointLabel(baseUrl),
    }
  }, [activeProject, activeTerminal])

  useEffect(() => {
    if (!projects.length) {
      setActiveProjectId(null)
      return
    }

    // Check if current active project is still valid
    if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
      return // Current selection is valid, don't change it
    }

    // Try to read from URL
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const requestedId = params?.get('project') ?? null
    if (requestedId && projects.some((project) => project.id === requestedId)) {
      setActiveProjectId(requestedId)
      return
    }

    // Fall back to first project
    setActiveProjectId(projects[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

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

  const triggerProjectResync = () => {
    setProjectSyncNonce((prev) => prev + 1)
  }

  const handleAuthSubmit = async (event) => {
    event.preventDefault()
    const username = authForm.username.trim().toLowerCase()
    const password = authForm.password
    if (!username || !password) {
      setAuthError('Username and password are required.')
      return
    }
    setAuthBusy(true)
    setAuthError('')
    try {
      const endpoint = authMode === 'register' ? '/auth/register' : '/auth/login'
      const payload = await apiFetch(endpoint, {
        method: 'POST',
        body: { username, password },
      })
      if (payload.user) {
        setCurrentUser(payload.user)
        if (Array.isArray(payload.user.projects)) {
          setProjects(normalizeProjects(payload.user.projects))
        } else {
          setProjects(getDefaultProjects())
        }
      }
      if (payload.token) {
        setAuthToken(payload.token)
      }
      setAuthForm({ username: '', password: '' })
      setAuthError('')
    } catch (error) {
      setAuthError(error.message ?? 'Unable to authenticate.')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = () => {
    setAuthToken('')
    setCurrentUser(null)
    setAuthForm({ username: '', password: '' })
    setProjects(guestProjectsRef.current ?? getDefaultProjects())
    setSyncError('')
    setIsSyncingProjects(false)
  }

  const handleSelectProject = (projectId) => {
    setActiveProjectId(projectId)
    setShowTerminalForm(false)
    setShowSettings(false)
  }

  const handleRemoveProject = (projectId) => {
    setConfirmDialog({
      isOpen: true,
      message: 'Delete this project and all its terminals?',
      onConfirm: () => {
        setProjects((prev) => prev.filter((project) => project.id !== projectId))
        if (activeProjectId === projectId) {
          setActiveProjectId(null)
          setActiveTerminalId(null)
          setShowTerminalForm(false)
        }
        setConfirmDialog({ isOpen: false, message: '', onConfirm: null })
      },
    })
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
    setConfirmDialog({
      isOpen: true,
      message: 'Delete this terminal?',
      onConfirm: () => {
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
        setConfirmDialog({ isOpen: false, message: '', onConfirm: null })
      },
    })
  }

  const handleOpenProjectTab = () => {
    if (typeof window === 'undefined' || !activeProjectId) {
      return
    }
    const url = `${window.location.origin}${window.location.pathname}?project=${activeProjectId}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const renderProjectSelector = () => {
    if (!projects.length) {
      return null
    }
    if (projectViewMode === PROJECT_VIEW_MODES.TABS) {
      return (
        <div className="project-tabs-inline">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId
            return (
              <button
                key={project.id}
                type="button"
                className={`project-tab ${isActive ? 'active' : ''}`}
                onClick={() => handleSelectProject(project.id)}
                title={project.description || project.name}
              >
                <span>{project.name}</span>
                {projects.length > 1 && (
                  <span
                    className="remove-project"
                    role="button"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation()
                      handleRemoveProject(project.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleRemoveProject(project.id)
                      }
                    }}
                    title="Delete project"
                  >
                    ✕
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )
    }
    return (
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
    )
  }

  return (
    <div className="app-shell">
      <section className="auth-panel">
        {authStatus === 'checking' ? (
          <p className="auth-message">Validating session…</p>
        ) : currentUser ? (
          <div className="auth-status-row">
            <div>
              <span className="auth-label">Signed in as</span>
              <strong>{currentUser.username}</strong>
            </div>
            <div className="auth-status-actions">
              {isSyncingProjects ? (
                <span className="sync-indicator syncing">Syncing…</span>
              ) : syncError ? (
                <button type="button" className="sync-indicator error" onClick={triggerProjectResync}>
                  Sync failed — retry
                </button>
              ) : (
                <span className="sync-indicator ok">Projects synced</span>
              )}
              <button type="button" className="secondary" onClick={handleLogout}>
                Logout
              </button>
            </div>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <div className="auth-fields">
              <input
                type="text"
                placeholder="Username"
                autoComplete="username"
                value={authForm.username}
                onChange={(e) => setAuthForm((prev) => ({ ...prev, username: e.target.value }))}
                disabled={authBusy}
                required
              />
              <input
                type="password"
                placeholder="Password"
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                value={authForm.password}
                onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                disabled={authBusy}
                required
              />
            </div>
            <div className="auth-actions">
              <button type="submit" className="primary" disabled={authBusy}>
                {authMode === 'register' ? 'Create account' : 'Sign in'}
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setAuthMode((prev) => (prev === 'register' ? 'login' : 'register'))
                  setAuthError('')
                }}
                disabled={authBusy}
              >
                {authMode === 'register' ? 'Have an account? Sign in' : 'Need an account? Register'}
              </button>
            </div>
            {authError && <p className="auth-error">{authError}</p>}
          </form>
        )}
      </section>
      <header className="app-header-compact">
        <div className="header-left">
          <h1>AI Workflow</h1>
          {renderProjectSelector()}
        </div>
        <div className="header-actions">
          {projects.length > 0 && (
            <button
              type="button"
              className={`icon-btn project-view-toggle ${
                projectViewMode === PROJECT_VIEW_MODES.TABS ? 'active' : ''
              }`}
              onClick={() =>
                setProjectViewMode((prev) =>
                  prev === PROJECT_VIEW_MODES.TABS
                    ? PROJECT_VIEW_MODES.DROPDOWN
                    : PROJECT_VIEW_MODES.TABS,
                )
              }
              title={
                projectViewMode === PROJECT_VIEW_MODES.TABS
                  ? 'Switch to dropdown view'
                  : 'Switch to tabbed view'
              }
            >
              {projectViewMode === PROJECT_VIEW_MODES.TABS ? '▤' : '☰'}
            </button>
          )}
          <button
            type="button"
            className={`icon-btn ${showVoicePanel ? 'active' : ''}`}
            onClick={() => setShowVoicePanel((prev) => !prev)}
            title="Voice transcription"
          >
            🎙️
          </button>
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

      {showVoicePanel && (
        <section className="voice-panel">
          <div className="voice-panel-header">
            <div className="voice-title">
              <h2>Voice transcription</h2>
              <span className="voice-status">{voiceStatus}</span>
            </div>
            <button className="icon-btn" onClick={() => setShowVoicePanel(false)} title="Close">
              ✕
            </button>
          </div>
          {!isSecureContext && (
            <p className="voice-warning">
              Microphone recording requires HTTPS (or http://localhost). You can still upload audio files below.
            </p>
          )}
          <div className="voice-row">
            <div className="voice-controls">
              <button
                type="button"
                className="primary"
                onClick={handleVoiceRecordingStart}
                disabled={!isSecureContext || voiceRecording || voicePending}
              >
                {voiceRecording ? 'Recording…' : 'Start recording'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={handleVoiceRecordingStop}
                disabled={!voiceRecording}
              >
                Stop
              </button>
              <label className="voice-upload">
                <input type="file" accept="audio/*" onChange={handleVoiceFileInputChange} />
                <span>Upload audio</span>
              </label>
            </div>
            <label className="voice-language">
              <span>Language</span>
              <select value={voiceLanguage} onChange={(e) => setVoiceLanguage(e.target.value)}>
                <option value="">Auto-detect</option>
                <option value="pt">Português</option>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
          </div>
          <textarea
            className="voice-transcript"
            placeholder="Transcript will appear here."
            value={voiceTranscript}
            readOnly
            rows={3}
          />
          {voiceError && <p className="voice-error">{voiceError}</p>}
          <div className="voice-actions">
            <button type="button" className="secondary" onClick={handleCopyTranscript} disabled={!voiceTranscript}>
              Copy transcript
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleSendTranscriptToTerminal}
              disabled={!voiceTranscript || !activeTerminal || voicePending}
            >
              Send to terminal
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setVoiceTranscript('')
                setVoiceError('')
              }}
              disabled={!voiceTranscript && !voiceError}
            >
              Clear
            </button>
          </div>
        </section>
      )}

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
                <div className="terminal-view-header">
                  <div>
                    <h3>{activeTerminal.name}</h3>
                    {(activeTerminal.notes || activeProject.description) && (
                      <p>{activeTerminal.notes || activeProject.description}</p>
                    )}
                  </div>
                  {activeConnection && (
                    <div className="terminal-header-controls">
                      <div className="terminal-endpoint">
                        <span>Endpoint</span>
                        <code>{activeConnection.endpointLabel}</code>
                      </div>
                      <label className="terminal-font-control">
                        Font
                        <select
                          value={terminalFontSize}
                          onChange={(e) => setTerminalFontSize(Number(e.target.value))}
                        >
                          {FONT_SIZE_OPTIONS.map((size) => (
                            <option key={size} value={size}>
                              {size}px
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
                {activeConnection ? (
                  <TerminalViewer
                    key={`${activeProject.id}-${activeTerminal.id}`}
                    wsUrl={activeConnection.wsUrl}
                    fontSize={terminalFontSize}
                    onBridgeReady={setTerminalBridge}
                  />
                ) : (
                  <div className="terminal-warning">
                    <p>Unable to compute connection details.</p>
                  </div>
                )}
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

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, message: '', onConfirm: null })}
      />
    </div>
  )
}

export default App
