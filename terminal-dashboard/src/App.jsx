import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import './App.css'

// Components
import TerminalViewer from './components/terminal/TerminalViewer'
import ConfirmDialog from './components/dialogs/ConfirmDialog'
import MobileLayout from './components/layout/MobileLayout'
import WorkspaceSheet from './components/sheets/WorkspaceSheet'
import WindowSheet from './components/sheets/WindowSheet'
import VoiceSheet from './components/sheets/VoiceSheet'
import SettingsSheet from './components/sheets/SettingsSheet'
import WorkspaceCard from './components/workspace/WorkspaceCard'
import WindowTabs from './components/workspace/WindowTabs'

// Hooks
import { useIsMobile, useMediaQuery } from './hooks/useMediaQuery'
import { useWorkspaces } from './hooks/useWorkspaces'

// Storage keys
const FONT_SIZE_STORAGE_KEY = 'terminal-dashboard-font-size'
const VOICE_SERVICE_STORAGE_KEY = 'terminal-dashboard-voice-service'
const VOICE_LANGUAGE_STORAGE_KEY = 'terminal-dashboard-voice-language'
const OVERVIEW_COLUMNS_STORAGE_KEY = 'terminal-dashboard-overview-columns'

// Constants
const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 22]
const DEFAULT_FONT_SIZE = 16
const OVERVIEW_MIN_FONT_SIZE = 12
const DEFAULT_OVERVIEW_COLUMNS = 3
const MIN_OVERVIEW_COLUMNS = 1
const MAX_OVERVIEW_COLUMNS = 6
const VOICE_SERVICES = {
  LOCAL: 'local',
  DEEPGRAM: 'deepgram',
}
const DEEPGRAM_API_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY || ''

// API base detection for voice transcription
const detectApiBase = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:5001'
  }
  const { protocol, hostname, port } = window.location
  const isDevPort = port && port !== '80' && port !== '443'
  if (isDevPort) {
    return `${protocol}//${hostname}:5001`
  }
  const portSuffix = port ? `:${port}` : ''
  return `${protocol}//${hostname}${portSuffix}/api`
}

const API_BASE = detectApiBase()

/**
 * Build WebSocket URL for workspace terminal connection
 */
const buildWorkspaceSocketUrl = (workspaceId, windowIndex = null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const port = window.location.port ? `:${window.location.port}` : ''
  let url = `${protocol}//${window.location.hostname}${port}/ws/sessions/${workspaceId}`
  if (windowIndex !== null && Number.isFinite(windowIndex)) {
    url += `?windowIndex=${windowIndex}`
  }
  return url
}

function App() {
  const isMobile = useIsMobile()
  const isLargeScreen = useMediaQuery('(min-width: 1280px)')
  const canUseOverview = !isMobile && isLargeScreen

  // Workspaces from API (read-only)
  const {
    workspaces,
    loading: workspacesLoading,
    error: workspacesError,
    refresh: refreshWorkspaces,
    fetchWindows,
  } = useWorkspaces()

  // Active workspace and window state
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null)
  const [activeWindowIndex, setActiveWindowIndex] = useState(null)
  const [windows, setWindows] = useState([])
  const [windowsLoading, setWindowsLoading] = useState(false)

  // Terminal state
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
    const stored = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
    return stored ? Number(stored) : DEFAULT_FONT_SIZE
  })
  const terminalBridgeRef = useRef(null)
  const handleTerminalBridgeReady = useCallback((bridge) => {
    terminalBridgeRef.current = bridge
  }, [])
  const [overviewMode, setOverviewMode] = useState(false)
  const [overviewColumns, setOverviewColumns] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_OVERVIEW_COLUMNS
    const stored = Number(window.localStorage.getItem(OVERVIEW_COLUMNS_STORAGE_KEY))
    if (Number.isFinite(stored)) {
      return Math.min(MAX_OVERVIEW_COLUMNS, Math.max(MIN_OVERVIEW_COLUMNS, stored))
    }
    return DEFAULT_OVERVIEW_COLUMNS
  })

  // Voice transcription state
  const [voiceService, setVoiceService] = useState(() => {
    if (typeof window === 'undefined') return VOICE_SERVICES.LOCAL
    return window.localStorage.getItem(VOICE_SERVICE_STORAGE_KEY) || VOICE_SERVICES.LOCAL
  })
  const [voiceLanguage, setVoiceLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'pt'
    return window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY) || 'pt'
  })
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceStatus, setVoiceStatus] = useState('Idle')
  const [voiceError, setVoiceError] = useState('')
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voicePending, setVoicePending] = useState(false)
  const voiceRecorderRef = useRef(null)
  const voiceStreamRef = useRef(null)
  const voiceChunksRef = useRef([])

  // UI state
  const [activeSheet, setActiveSheet] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState({
    isOpen: false,
    message: '',
    onConfirm: null,
  })

  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.active),
    [workspaces],
  )
  const overviewFontSize = useMemo(() => {
    const reduction = Math.min(4, Math.max(2, overviewColumns - 2))
    return Math.max(OVERVIEW_MIN_FONT_SIZE, terminalFontSize - reduction)
  }, [overviewColumns, terminalFontSize])

  // Check if we're in a secure context (for microphone access)
  const isSecureContext = typeof window !== 'undefined' &&
    (window.isSecureContext || window.location.protocol === 'https:')

  // Get active workspace
  const activeWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId]
  )

  // Load windows when workspace changes
  useEffect(() => {
    if (!activeWorkspaceId) {
      setWindows([])
      setActiveWindowIndex(null)
      return
    }

    let cancelled = false
    const loadWindows = async () => {
      setWindowsLoading(true)
      const windowList = await fetchWindows(activeWorkspaceId)
      if (!cancelled) {
        setWindows(windowList)
        setWindowsLoading(false)
        // Auto-select first window if none selected
        if (windowList.length > 0 && activeWindowIndex === null) {
          const activeWindow = windowList.find((w) => w.active)
          setActiveWindowIndex(activeWindow?.index ?? windowList[0].index)
        }
      }
    }

    loadWindows()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, fetchWindows])

  useEffect(() => {
    if (!canUseOverview && overviewMode) {
      setOverviewMode(false)
    }
  }, [canUseOverview, overviewMode])

  // Refresh windows
  const handleRefreshWindows = useCallback(async () => {
    if (!activeWorkspaceId) return
    setWindowsLoading(true)
    const windowList = await fetchWindows(activeWorkspaceId)
    setWindows(windowList)
    setWindowsLoading(false)
  }, [activeWorkspaceId, fetchWindows])

  // Persist font size
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(terminalFontSize))
  }, [terminalFontSize])

  // Persist voice settings
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(VOICE_SERVICE_STORAGE_KEY, voiceService)
  }, [voiceService])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, voiceLanguage)
  }, [voiceLanguage])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(OVERVIEW_COLUMNS_STORAGE_KEY, String(overviewColumns))
  }, [overviewColumns])

  // Voice transcription functions
  const waitForTerminalConnection = async (timeoutMs = 1500) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const bridge = terminalBridgeRef.current
      if (bridge?.isConnected?.()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  const trySendTranscriptToTerminal = async (text, { waitForReady = false } = {}) => {
    const trimmed = text.trim()
    if (!trimmed) return false
    const payload = `${trimmed}\n`
    const bridge = terminalBridgeRef.current
    if (bridge?.sendInput?.(payload)) {
      return true
    }
    if (!waitForReady) {
      return false
    }
    const ready = await waitForTerminalConnection()
    if (!ready) {
      return false
    }
    return terminalBridgeRef.current?.sendInput?.(payload) ?? false
  }

  const tryCopyTranscriptToClipboard = async (text, { silent = false } = {}) => {
    const trimmed = text.trim()
    if (!trimmed) {
      if (!silent) {
        setVoiceError('No transcript to copy.')
      }
      return false
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      if (!silent) {
        setVoiceError('Clipboard access is unavailable in this browser.')
      }
      return false
    }
    try {
      await navigator.clipboard.writeText(trimmed)
      if (!silent) {
        setVoiceStatus('Copied to clipboard')
        setVoiceError('')
      }
      return true
    } catch (error) {
      console.error(error)
      if (!silent) {
        setVoiceError('Failed to copy transcript.')
      }
      return false
    }
  }

  const cleanupVoiceResources = () => {
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
  }

  const sendVoiceFileForTranscription = async (blob, autoSend = false) => {
    setVoicePending(true)
    setVoiceStatus('Transcribing…')
    setVoiceError('')
    try {
      const formData = new FormData()
      formData.append('file', blob, 'recording.webm')
      formData.append('language', voiceLanguage)
      formData.append('translate', 'false')

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
          }
        )
        if (!deepgramResponse.ok) {
          throw new Error('Deepgram transcription failed')
        }
        const deepgramData = await deepgramResponse.json()
        transcriptText =
          deepgramData.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
      } else {
        const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
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
      const trimmed = transcriptText.trim()
      let didSend = false
      if (autoSend && trimmed) {
        didSend = await trySendTranscriptToTerminal(trimmed, { waitForReady: true })
      }
      const didCopy = trimmed ? await tryCopyTranscriptToClipboard(trimmed, { silent: true }) : false

      if (didSend && didCopy) {
        setVoiceStatus('Sent to terminal + copied')
      } else if (didSend) {
        setVoiceStatus('Sent to terminal')
      } else if (didCopy) {
        setVoiceStatus('Copied to clipboard')
      } else {
        setVoiceStatus('Ready')
      }

      if (didSend) {
        setVoiceTranscript('')
      }
    } catch (error) {
      console.error(error)
      setVoiceError(error.message ?? 'Transcription failed')
      setVoiceStatus('Error')
    } finally {
      setVoicePending(false)
    }
  }

  const handleVoiceRecordingStart = async (autoSendToTerminal = false) => {
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
        setVoiceStatus('Recording…')
      })
      recorder.addEventListener('stop', async () => {
        setVoiceRecording(false)
        const blobData = new Blob(voiceChunksRef.current, { type: 'audio/webm' })
        cleanupVoiceResources()
        if (!blobData.size) {
          setVoiceError('No audio captured.')
          setVoiceStatus('Idle')
          return
        }
        await sendVoiceFileForTranscription(blobData, autoSendToTerminal)
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
    if (!file) return
    cleanupVoiceResources()
    await sendVoiceFileForTranscription(file)
  }

  const handleCopyTranscript = async () => {
    await tryCopyTranscriptToClipboard(voiceTranscript)
  }

  const handleSendTranscriptToTerminal = async () => {
    const text = voiceTranscript.trim()
    if (!text) {
      setVoiceError('No transcript available.')
      return
    }
    if (!terminalBridgeRef.current) {
      setVoiceError('Select a workspace and window first.')
      return
    }
    const didSend = await trySendTranscriptToTerminal(text, { waitForReady: true })
    if (!didSend) {
      setVoiceError('Terminal connection is not ready.')
      return
    }
    setVoiceStatus('Sent to terminal')
    setVoiceTranscript('')
    setVoiceError('')
  }

  const handleMicToggle = () => {
    if (voicePending) return
    if (voiceRecording) {
      handleVoiceRecordingStop()
    } else {
      handleVoiceRecordingStart(true)
    }
  }

  // Build WebSocket URL
  const wsUrl = useMemo(() => {
    if (!activeWorkspaceId) return null
    return buildWorkspaceSocketUrl(activeWorkspaceId, activeWindowIndex)
  }, [activeWorkspaceId, activeWindowIndex])

  // Render terminal view
  const renderTerminalView = () => {
    if (overviewMode && canUseOverview) {
      if (workspacesLoading) {
        return (
          <div className="empty-state">
            <p>Loading workspaces...</p>
          </div>
        )
      }

      if (workspacesError) {
        return (
          <div className="empty-state">
            <p>Unable to load workspaces</p>
            <p className="hint">{workspacesError}</p>
          </div>
        )
      }

      if (activeWorkspaces.length === 0) {
        return (
          <div className="empty-state">
            <p>No active workspaces</p>
            <p className="hint">Start sessions in your x2go terminal first</p>
          </div>
        )
      }

      return (
        <section className="workspace-overview">
          <div className="workspace-overview-header">
            <div>
              <h2>Active workspaces</h2>
              <p>Live terminals from running agents</p>
            </div>
            <div className="workspace-overview-controls">
              <div className="workspace-overview-meta">
                {activeWorkspaces.length} active
              </div>
              <div className="workspace-overview-columns-control">
                <span>Columns</span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() =>
                    setOverviewColumns((prev) =>
                      Math.max(MIN_OVERVIEW_COLUMNS, prev - 1)
                    )
                  }
                  disabled={overviewColumns <= MIN_OVERVIEW_COLUMNS}
                  title="Fewer columns"
                >
                  −
                </button>
                <span className="workspace-overview-columns-value">
                  {overviewColumns}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() =>
                    setOverviewColumns((prev) =>
                      Math.min(MAX_OVERVIEW_COLUMNS, prev + 1)
                    )
                  }
                  disabled={overviewColumns >= MAX_OVERVIEW_COLUMNS}
                  title="More columns"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          <div
            className="workspace-overview-grid"
            style={{ '--overview-columns': overviewColumns }}
          >
            {activeWorkspaces.map((workspace) => (
              <article
                key={`overview-${workspace.id}`}
                className="workspace-overview-card"
                style={{ '--workspace-color': workspace.color || '#6366f1' }}
              >
                <header className="workspace-overview-card-header">
                  <div>
                    <h3>{workspace.name}</h3>
                    {workspace.description && (
                      <p>{workspace.description}</p>
                    )}
                  </div>
                  <span className="workspace-overview-card-status">●</span>
                </header>
                <TerminalViewer
                  wsUrl={buildWorkspaceSocketUrl(
                    workspace.id,
                    workspace.id === activeWorkspaceId ? activeWindowIndex : null,
                  )}
                  fontSize={overviewFontSize}
                  showShortcutBar={false}
                  onBridgeReady={
                    workspace.id === activeWorkspaceId ? handleTerminalBridgeReady : undefined
                  }
                />
              </article>
            ))}
          </div>
        </section>
      )
    }

    if (workspacesLoading) {
      return (
        <div className="empty-state">
          <p>Loading workspaces...</p>
        </div>
      )
    }

    if (!activeWorkspace) {
      return (
        <div className="empty-state">
          <p>Select a workspace to get started</p>
          <p className="hint">Workspaces are managed via the GTK panel (wsp)</p>
        </div>
      )
    }

    if (!activeWorkspace.active) {
      return (
        <div className="empty-state">
          <p>Session not active</p>
          <p className="hint">Start the session in your x2go terminal first</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              refreshWorkspaces()
              handleRefreshWindows()
            }}
          >
            Refresh
          </button>
        </div>
      )
    }

    if (!wsUrl) {
      return (
        <div className="empty-state">
          <p>Unable to connect to terminal</p>
        </div>
      )
    }

    return (
      <section className="terminal-view-fullscreen">
        <div className="terminal-view-header">
          <div>
            <h3>{activeWorkspace.name}</h3>
            {activeWorkspace.description && (
              <p>{activeWorkspace.description}</p>
            )}
          </div>
          <div className="terminal-header-controls">
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
        </div>

        {/* Window tabs */}
        {!isMobile && (
          <WindowTabs
            windows={windows}
            activeWindowIndex={activeWindowIndex}
            onSelectWindow={setActiveWindowIndex}
            onRefresh={handleRefreshWindows}
            loading={windowsLoading}
          />
        )}

        <TerminalViewer
          key={`${activeWorkspaceId}-${activeWindowIndex}`}
          wsUrl={wsUrl}
          fontSize={terminalFontSize}
          onBridgeReady={handleTerminalBridgeReady}
        />
      </section>
    )
  }

  // Mobile layout
  if (isMobile) {
    return (
      <>
        <MobileLayout
          activeSheet={activeSheet}
          onSheetChange={setActiveSheet}
          projectName={activeWorkspace?.name}
          isRecording={voiceRecording}
          isPending={voicePending}
          planePendingCount={0}
        >
          {renderTerminalView()}
        </MobileLayout>

        <WorkspaceSheet
          isOpen={activeSheet === 'projects'}
          onClose={() => setActiveSheet(null)}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={setActiveWorkspaceId}
          loading={workspacesLoading}
          error={workspacesError}
          onRefresh={refreshWorkspaces}
        />

        <WindowSheet
          isOpen={activeSheet === 'terminals'}
          onClose={() => setActiveSheet(null)}
          windows={windows}
          activeWindowIndex={activeWindowIndex}
          onSelectWindow={setActiveWindowIndex}
          workspaceName={activeWorkspace?.name}
          loading={windowsLoading}
          onRefresh={handleRefreshWindows}
        />

        <VoiceSheet
          isOpen={activeSheet === 'voice'}
          onClose={() => setActiveSheet(null)}
          isSecureContext={isSecureContext}
          voiceService={voiceService}
          onVoiceServiceChange={setVoiceService}
          voiceLanguage={voiceLanguage}
          onVoiceLanguageChange={setVoiceLanguage}
          voiceTranscript={voiceTranscript}
          voiceStatus={voiceStatus}
          voiceError={voiceError}
          voiceRecording={voiceRecording}
          voicePending={voicePending}
          hasDeepgramKey={!!DEEPGRAM_API_KEY}
          hasTerminal={!!activeWorkspace?.active}
          onStartRecording={() => handleVoiceRecordingStart(true)}
          onStopRecording={handleVoiceRecordingStop}
          onFileUpload={handleVoiceFileSelection}
          onCopyTranscript={handleCopyTranscript}
          onSendToTerminal={handleSendTranscriptToTerminal}
          onClearTranscript={() => {
            setVoiceTranscript('')
            setVoiceError('')
            setVoiceStatus('Idle')
          }}
        />

        <SettingsSheet
          isOpen={activeSheet === 'settings'}
          onClose={() => setActiveSheet(null)}
          authStatus="loggedOut"
          currentUser={null}
          authMode="login"
          authForm={{ username: '', password: '' }}
          authError=""
          authBusy={false}
          isSyncingProjects={false}
          syncError=""
          onAuthFormChange={() => {}}
          onAuthModeToggle={() => {}}
          onAuthSubmit={(e) => e.preventDefault()}
          onLogout={() => {}}
          onRetrySync={() => {}}
          terminalFontSize={terminalFontSize}
          onFontSizeChange={setTerminalFontSize}
          projectViewMode="dropdown"
          onProjectViewModeChange={() => {}}
        />

        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog({ isOpen: false, message: '', onConfirm: null })}
        />
      </>
    )
  }

  // Desktop layout
  return (
    <div className="app-shell">
      {/* Header with workspaces */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Terminal Dashboard</h1>
          {workspacesError && (
            <span className="header-error">{workspacesError}</span>
          )}
        </div>

        <div className="header-center">
          <div className="workspace-cards">
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                isSelected={workspace.id === activeWorkspaceId}
                onSelect={(ws) => setActiveWorkspaceId(ws.id)}
              />
            ))}
            {workspaces.length === 0 && !workspacesLoading && (
              <span className="no-workspaces">
                No workspaces configured. Use wsp to add workspaces.
              </span>
            )}
          </div>
        </div>

        <div className="header-right">
          {canUseOverview && (
            <button
              type="button"
              className={`secondary overview-toggle ${overviewMode ? 'active' : ''}`}
              onClick={() => setOverviewMode((prev) => !prev)}
              title={overviewMode ? 'Switch to single workspace view' : 'Show all active workspaces'}
            >
              {overviewMode ? 'Single' : 'Grid'}
            </button>
          )}
          <button
            type="button"
            className={`mic-toggle ${voiceRecording ? 'recording' : ''} ${voicePending ? 'pending' : ''}`}
            onClick={handleMicToggle}
            disabled={voicePending || !isSecureContext}
            title={voiceRecording ? 'Stop recording' : 'Start voice recording'}
          >
            {voiceRecording ? '⏹' : '🎤'}
          </button>
          <button
            type="button"
            className="secondary refresh-btn"
            onClick={refreshWorkspaces}
            title="Refresh workspaces"
          >
            ↻
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="app-main">
        {renderTerminalView()}
      </main>

      {/* Voice status bar */}
      {(voiceTranscript || voiceError || voiceStatus !== 'Idle') && (
        <div className="voice-status-bar">
          {voiceError ? (
            <span className="voice-error">{voiceError}</span>
          ) : voiceTranscript ? (
            <div className="voice-transcript-row">
              <span className="voice-transcript">{voiceTranscript}</span>
              <button type="button" onClick={handleCopyTranscript}>Copy</button>
              <button type="button" onClick={handleSendTranscriptToTerminal}>Send</button>
              <button type="button" onClick={() => setVoiceTranscript('')}>Clear</button>
            </div>
          ) : (
            <span className="voice-status">{voiceStatus}</span>
          )}
        </div>
      )}

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
