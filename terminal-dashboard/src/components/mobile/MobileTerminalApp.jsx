import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TerminalViewer from '../terminal/TerminalViewer'
import { useMediaQuery } from '../../hooks/useMediaQuery'

const FONT_SIZE_STORAGE_KEY = 'terminal-dashboard-mobile-font-size'
const VOICE_SERVICE_STORAGE_KEY = 'terminal-dashboard-voice-service'
const VOICE_LANGUAGE_STORAGE_KEY = 'terminal-dashboard-voice-language'
const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 22]
const DEFAULT_FONT_SIZE = 16
const VOICE_SERVICES = {
  LOCAL: 'local',
  DEEPGRAM: 'deepgram',
}
const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''

const detectVoiceApiBase = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:8000'
  }
  const { protocol, hostname, port, origin } = window.location
  if (port === '5173') {
    return `${protocol}//${hostname}:8000`
  }
  return `${origin}/api/whisper`
}

const buildMobileSocketUrl = (workspace, windowIndex) => {
  if (!workspace) {
    return null
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const port = window.location.port ? `:${window.location.port}` : ''
  const params = new URLSearchParams()
  if (Number.isFinite(windowIndex)) {
    params.set('windowIndex', String(windowIndex))
  }
  const sessionId = encodeURIComponent(workspace.connection?.sessionId || workspace.id)
  const path = workspace.connection?.type === 'remote'
    ? `/ws/remote-sessions/${encodeURIComponent(workspace.hostId)}/${sessionId}`
    : `/ws/sessions/${sessionId}`
  const query = params.toString()
  return `${protocol}//${window.location.hostname}${port}${path}${query ? `?${query}` : ''}`
}

const formatActivity = (value) => {
  if (!value) {
    return 'no activity'
  }
  const diffMs = Math.max(0, Date.now() - value)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

function WorkspaceList({ hosts, query, onQueryChange, selectedKey, onSelectWorkspace, onRefresh, loading }) {
  const normalizedQuery = query.trim().toLowerCase()
  const visibleHosts = hosts.map((host) => ({
    ...host,
    workspaces: host.workspaces.filter((workspace) => {
      if (!normalizedQuery) {
        return true
      }
      return [
        workspace.name,
        workspace.id,
        workspace.description,
        workspace.path,
        workspace.hostName,
      ].join(' ').toLowerCase().includes(normalizedQuery)
    }),
  })).filter((host) => host.workspaces.length || !normalizedQuery)

  return (
    <section className="mobile-workspace-list">
      <div className="mobile-search-row">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter workspaces, hosts, paths..."
          aria-label="Filter workspaces"
        />
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="mobile-host-groups">
        {visibleHosts.map((host) => (
          <section key={host.id} className={`mobile-host-group ${host.reachable ? '' : 'unreachable'}`}>
            <header className="mobile-host-header">
              <span>{host.name}</span>
              <small>
                {host.reachable
                  ? `${host.activeWorkspaceCount}/${host.workspaceCount} active`
                  : 'unreachable'}
              </small>
            </header>
            {host.error && <p className="mobile-host-error">{host.error}</p>}
            {host.workspaces.map((workspace) => (
              <button
                key={workspace.key}
                type="button"
                className={`mobile-workspace-button ${selectedKey === workspace.key ? 'selected' : ''}`}
                onClick={() => onSelectWorkspace(workspace)}
                disabled={!workspace.reachable}
              >
                <span className={`mobile-workspace-dot ${workspace.active ? 'active' : ''}`} />
                <span className="mobile-workspace-main">
                  <strong>{workspace.name}</strong>
                  <small>{workspace.path || workspace.description || workspace.id}</small>
                </span>
                <span className="mobile-workspace-meta">
                  <span>{workspace.windowCount || 0} tabs</span>
                  <small>{formatActivity(workspace.lastActivityAt)}</small>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </section>
  )
}

function WindowList({ workspace, selectedIndex, onSelectWindow, onBack, onRefresh, loading }) {
  if (!workspace) {
    return (
      <section className="mobile-window-list empty">
        <p>Select a workspace first.</p>
      </section>
    )
  }

  return (
    <section className="mobile-window-list">
      <header className="mobile-panel-header">
        {onBack && (
          <button type="button" className="mobile-ghost-btn" onClick={onBack}>
            Back
          </button>
        )}
        <div>
          <h2>{workspace.name}</h2>
          <p>{workspace.hostName}</p>
        </div>
        <button type="button" className="mobile-ghost-btn" onClick={onRefresh} disabled={loading}>
          {loading ? '...' : 'Refresh'}
        </button>
      </header>

      {workspace.windows.length === 0 ? (
        <div className="mobile-empty-card">
          <strong>No active tmux windows</strong>
          <p>Start this session on the VM, then refresh.</p>
        </div>
      ) : (
        <div className="mobile-window-buttons">
          {workspace.windows.map((window) => (
            <button
              key={window.index}
              type="button"
              className={`mobile-window-button ${selectedIndex === window.index ? 'selected' : ''}`}
              onClick={() => onSelectWindow(window)}
            >
              <span className="mobile-window-index">#{window.index}</span>
              <span className="mobile-window-name">{window.name}</span>
              <span className="mobile-window-meta">{formatActivity(window.lastActivityAt)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function VoicePanel({
  transcript,
  status,
  error,
  pending,
  onSend,
  onCopy,
  onClear,
}) {
  if (!transcript && !status && !error && !pending) {
    return null
  }
  return (
    <div className="mobile-voice-panel">
      {error ? (
        <p className="mobile-voice-error">{error}</p>
      ) : transcript ? (
        <>
          <p>{transcript}</p>
          <div className="mobile-voice-actions">
            <button type="button" onClick={onSend} disabled={pending}>Send</button>
            <button type="button" onClick={onCopy} disabled={pending}>Copy</button>
            <button type="button" onClick={onClear} disabled={pending}>Clear</button>
          </div>
        </>
      ) : (
        <p>{status}</p>
      )}
    </div>
  )
}

function MobileTerminalApp() {
  const isTablet = useMediaQuery('(min-width: 820px)')
  const [hosts, setHosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState('workspaces')
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState(null)
  const [selectedWindowIndex, setSelectedWindowIndex] = useState(null)
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
    const stored = Number(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY))
    return Number.isFinite(stored) ? stored : DEFAULT_FONT_SIZE
  })
  const [voiceService] = useState(() => {
    if (typeof window === 'undefined') return VOICE_SERVICES.LOCAL
    return window.localStorage.getItem(VOICE_SERVICE_STORAGE_KEY) || VOICE_SERVICES.LOCAL
  })
  const [voiceLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'pt-BR'
    return window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY) || 'pt-BR'
  })
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voicePending, setVoicePending] = useState(false)
  const terminalBridgeRef = useRef(null)
  const voiceRecorderRef = useRef(null)
  const voiceStreamRef = useRef(null)
  const voiceChunksRef = useRef([])

  const workspaces = useMemo(() => hosts.flatMap((host) => host.workspaces || []), [hosts])
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ?? null,
    [selectedWorkspaceKey, workspaces],
  )
  const selectedWindow = useMemo(
    () => selectedWorkspace?.windows?.find((window) => window.index === selectedWindowIndex) ?? null,
    [selectedWindowIndex, selectedWorkspace],
  )
  const wsUrl = useMemo(
    () => buildMobileSocketUrl(selectedWorkspace, selectedWindowIndex),
    [selectedWorkspace, selectedWindowIndex],
  )
  const canShowTerminal = !!(selectedWorkspace && selectedWindow && wsUrl)
  const isSecureContext = typeof window !== 'undefined' &&
    (window.isSecureContext || window.location.protocol === 'https:')

  const loadInventory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/mobile/workspaces')
      if (!response.ok) {
        throw new Error(`Mobile inventory failed: ${response.status}`)
      }
      const data = await response.json()
      setHosts(Array.isArray(data.hosts) ? data.hosts : [])
    } catch (loadError) {
      setError(loadError.message || 'Unable to load mobile workspace list')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadInventory()
  }, [loadInventory])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(terminalFontSize))
  }, [terminalFontSize])

  const refreshInventory = useCallback(async () => {
    await loadInventory()
  }, [loadInventory])

  const handleSelectWorkspace = useCallback((workspace) => {
    setSelectedWorkspaceKey(workspace.key)
    setSelectedWindowIndex(null)
    if (!isTablet) {
      setView('windows')
    }
  }, [isTablet])

  const handleSelectWindow = useCallback((window) => {
    setSelectedWindowIndex(window.index)
    if (!isTablet) {
      setView('terminal')
    }
  }, [isTablet])

  const cleanupVoiceResources = useCallback(() => {
    if (voiceRecorderRef.current) {
      try {
        voiceRecorderRef.current.stop()
      } catch {
        // ignore
      }
      voiceRecorderRef.current = null
    }
    if (voiceStreamRef.current) {
      voiceStreamRef.current.getTracks().forEach((track) => track.stop())
      voiceStreamRef.current = null
    }
    voiceChunksRef.current = []
  }, [])

  const sendVoiceFileForTranscription = useCallback(async (blob) => {
    setVoicePending(true)
    setVoiceStatus('Transcribing...')
    setVoiceError('')
    try {
      let transcriptText = ''
      if (voiceService === VOICE_SERVICES.DEEPGRAM && DEEPGRAM_API_KEY) {
        const deepgramResponse = await fetch(
          `https://api.deepgram.com/v1/listen?model=nova-2&language=${voiceLanguage}&punctuate=true`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${DEEPGRAM_API_KEY}`,
              'Content-Type': 'audio/webm',
            },
            body: blob,
          },
        )
        if (!deepgramResponse.ok) {
          throw new Error('Deepgram transcription failed')
        }
        const deepgramData = await deepgramResponse.json()
        transcriptText = deepgramData.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
      } else {
        const formData = new FormData()
        formData.append('file', blob, 'recording.webm')
        formData.append('language', voiceLanguage)
        formData.append('translate', 'false')
        const base = detectVoiceApiBase().replace(/\/$/, '')
        const response = await fetch(`${base}/transcribe`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Transcription service unavailable')
        }
        const data = await response.json()
        transcriptText = data.text ?? ''
      }

      setVoiceTranscript(transcriptText)
      setVoiceStatus(transcriptText.trim() ? 'Ready to send' : 'No speech detected')
    } catch (transcriptionError) {
      setVoiceError(transcriptionError.message || 'Transcription failed')
      setVoiceStatus('')
    } finally {
      setVoicePending(false)
    }
  }, [voiceLanguage, voiceService])

  const startRecording = useCallback(async () => {
    if (!isSecureContext) {
      setVoiceError('Microphone requires HTTPS or localhost.')
      return
    }
    cleanupVoiceResources()
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
        setVoiceStatus('Recording...')
      })
      recorder.addEventListener('stop', async () => {
        setVoiceRecording(false)
        const blobData = new Blob(voiceChunksRef.current, { type: 'audio/webm' })
        cleanupVoiceResources()
        if (!blobData.size) {
          setVoiceError('No audio captured.')
          setVoiceStatus('')
          return
        }
        await sendVoiceFileForTranscription(blobData)
      })
      recorder.start()
      voiceRecorderRef.current = recorder
    } catch (recordError) {
      setVoiceError(recordError.message || 'Unable to access microphone.')
      cleanupVoiceResources()
    }
  }, [cleanupVoiceResources, isSecureContext, sendVoiceFileForTranscription])

  const stopRecording = useCallback(() => {
    if (voiceRecorderRef.current && voiceRecorderRef.current.state !== 'inactive') {
      voiceRecorderRef.current.stop()
      return
    }
    cleanupVoiceResources()
  }, [cleanupVoiceResources])

  const toggleRecording = useCallback(() => {
    if (voicePending) return
    if (voiceRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }, [startRecording, stopRecording, voicePending, voiceRecording])

  const sendTranscript = useCallback(() => {
    const text = voiceTranscript.trim()
    if (!text) {
      return
    }
    const bridge = terminalBridgeRef.current
    if (!bridge?.sendInput?.(`${text}\n`)) {
      setVoiceError('Terminal connection is not ready.')
      return
    }
    setVoiceTranscript('')
    setVoiceError('')
    setVoiceStatus('Sent')
  }, [voiceTranscript])

  const copyTranscript = useCallback(async () => {
    const text = voiceTranscript.trim()
    if (!text || !navigator.clipboard) {
      return
    }
    await navigator.clipboard.writeText(text)
    setVoiceStatus('Copied')
  }, [voiceTranscript])

  const clearTranscript = useCallback(() => {
    setVoiceTranscript('')
    setVoiceError('')
    setVoiceStatus('')
  }, [])

  const terminalPanel = (
    <section className="mobile-terminal-panel">
      <header className="mobile-terminal-toolbar">
        {!isTablet && (
          <button type="button" className="mobile-ghost-btn" onClick={() => setView('windows')}>
            Back
          </button>
        )}
        <div className="mobile-terminal-title">
          <strong>{selectedWorkspace?.name || 'No terminal selected'}</strong>
          <small>
            {selectedWorkspace && selectedWindow
              ? `${selectedWorkspace.hostName} / #${selectedWindow.index} ${selectedWindow.name}`
              : 'Choose a workspace and tmux tab'}
          </small>
        </div>
        <label className="mobile-font-control">
          <span>Font</span>
          <select
            value={terminalFontSize}
            onChange={(event) => setTerminalFontSize(Number(event.target.value))}
          >
            {FONT_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`mobile-record-btn ${voiceRecording ? 'recording' : ''}`}
          onClick={toggleRecording}
          disabled={voicePending || !canShowTerminal}
        >
          {voiceRecording ? 'Stop' : voicePending ? 'Wait' : 'Voice'}
        </button>
      </header>

      {canShowTerminal ? (
        <TerminalViewer
          key={`${selectedWorkspace.key}-${selectedWindowIndex}`}
          wsUrl={wsUrl}
          fontSize={terminalFontSize}
          onBridgeReady={(bridge) => {
            terminalBridgeRef.current = bridge
          }}
        />
      ) : (
        <div className="mobile-terminal-empty">
          <strong>Select a tmux window</strong>
          <p>Pick a workspace, then choose one of its tabs to open the terminal.</p>
        </div>
      )}

      <VoicePanel
        transcript={voiceTranscript}
        status={voiceStatus}
        error={voiceError}
        pending={voicePending}
        onSend={sendTranscript}
        onCopy={copyTranscript}
        onClear={clearTranscript}
      />
    </section>
  )

  if (isTablet) {
    return (
      <div className="mobile-terminal-app tablet">
        <aside className="mobile-tablet-sidebar">
          <div className="mobile-app-title">
            <strong>Terminals</strong>
            <span>All VMs</span>
          </div>
          {error && <p className="mobile-global-error">{error}</p>}
          <WorkspaceList
            hosts={hosts}
            query={query}
            onQueryChange={setQuery}
            selectedKey={selectedWorkspaceKey}
            onSelectWorkspace={handleSelectWorkspace}
            onRefresh={refreshInventory}
            loading={loading}
          />
          <WindowList
            workspace={selectedWorkspace}
            selectedIndex={selectedWindowIndex}
            onSelectWindow={handleSelectWindow}
            onRefresh={refreshInventory}
            loading={loading}
          />
        </aside>
        {terminalPanel}
      </div>
    )
  }

  return (
    <div className="mobile-terminal-app phone">
      <header className="mobile-phone-header">
        <div>
          <strong>Terminals</strong>
          <span>All VMs</span>
        </div>
        {view !== 'workspaces' && (
          <button type="button" className="mobile-ghost-btn" onClick={() => setView('workspaces')}>
            Workspaces
          </button>
        )}
      </header>
      {error && <p className="mobile-global-error">{error}</p>}
      {view === 'workspaces' && (
        <WorkspaceList
          hosts={hosts}
          query={query}
          onQueryChange={setQuery}
          selectedKey={selectedWorkspaceKey}
          onSelectWorkspace={handleSelectWorkspace}
          onRefresh={refreshInventory}
          loading={loading}
        />
      )}
      {view === 'windows' && (
        <WindowList
          workspace={selectedWorkspace}
          selectedIndex={selectedWindowIndex}
          onSelectWindow={handleSelectWindow}
          onBack={() => setView('workspaces')}
          onRefresh={refreshInventory}
          loading={loading}
        />
      )}
      {view === 'terminal' && terminalPanel}
    </div>
  )
}

export default MobileTerminalApp
