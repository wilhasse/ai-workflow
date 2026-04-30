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
const RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/ogg;codecs=opus',
  'audio/ogg',
]

const resolveStoredFontSize = () => {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
  const stored = Number(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY))
  return FONT_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_FONT_SIZE
}

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

const getSpeechRecognitionConstructor = () => {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

const normalizeWhisperLanguage = (language) => {
  if (!language) return ''
  return language.split('-')[0].toLowerCase()
}

const pickRecorderMimeType = () => {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return ''
  }
  if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }
  return RECORDER_MIME_TYPES.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) || ''
}

const extensionForMimeType = (mimeType) => {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('aac')) return 'aac'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

const formatRecordingDetails = ({ recordingMs, size } = {}) => {
  const details = []
  if (Number.isFinite(recordingMs) && recordingMs > 0) {
    details.push(`${Math.round(recordingMs / 100) / 10}s`)
  }
  if (Number.isFinite(size) && size > 0) {
    details.push(`${Math.max(1, Math.round(size / 1024))} KB`)
  }
  return details.length ? ` (${details.join(', ')})` : ''
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

const formatAgentStatus = (agents) => {
  if (!agents || !agents.count) {
    return 'no agents'
  }
  if (agents.status === 'parked') {
    return `${agents.parked} parked`
  }
  if (agents.status === 'partial') {
    return `${agents.active} active / ${agents.parked} parked`
  }
  return `${agents.active || agents.count} active`
}

const agentActionLabel = (agents) => (agents?.status === 'parked' ? 'Resume' : 'Park')

function WorkspaceList({
  hosts,
  query,
  onQueryChange,
  selectedKey,
  onSelectWorkspace,
  onToggleAgents,
  agentActionKey,
  agentActionError,
  onRefresh,
  loading,
}) {
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
      {agentActionError && <p className="mobile-agent-error">{agentActionError}</p>}

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
            {host.workspaces.map((workspace) => {
              const agentBusy = agentActionKey === workspace.key
              const agentCount = workspace.agents?.count || 0
              const canToggleAgents = workspace.reachable && agentCount > 0 && !agentBusy
              return (
                <div
                  key={workspace.key}
                  role="button"
                  tabIndex={workspace.reachable ? 0 : -1}
                  aria-disabled={!workspace.reachable}
                  className={[
                    'mobile-workspace-button',
                    selectedKey === workspace.key ? 'selected' : '',
                    !workspace.reachable ? 'unreachable' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => {
                    if (workspace.reachable) {
                      onSelectWorkspace(workspace)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!workspace.reachable) {
                      return
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectWorkspace(workspace)
                    }
                  }}
                >
                  <span className={`mobile-workspace-dot ${workspace.active ? 'active' : ''}`} />
                  <span className="mobile-workspace-main">
                    <strong>{workspace.name}</strong>
                    <small>{workspace.path || workspace.description || workspace.id}</small>
                  </span>
                  <span className="mobile-workspace-meta">
                    <span>{workspace.windowCount || 0} tabs</span>
                    <small>{formatActivity(workspace.lastActivityAt)}</small>
                    <small className={`mobile-agent-pill ${workspace.agents?.status || 'none'}`}>
                      {formatAgentStatus(workspace.agents)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className={`mobile-agent-action ${workspace.agents?.status === 'parked' ? 'resume' : 'park'}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleAgents(workspace)
                    }}
                    disabled={!canToggleAgents}
                    aria-label={`${agentActionLabel(workspace.agents)} Codex and Claude agents in ${workspace.name}`}
                  >
                    {agentBusy ? '...' : agentActionLabel(workspace.agents)}
                  </button>
                </div>
              )
            })}
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

function MobileInputDock({
  value,
  disabled,
  error,
  onChange,
  onSend,
  onEnter,
  onSpace,
  onBackspace,
  onClear,
}) {
  return (
    <form
      className="mobile-input-dock"
      onSubmit={(event) => {
        event.preventDefault()
        onEnter()
      }}
    >
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onEnter()
          }
        }}
        rows={1}
        placeholder="Type command; Enter runs"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck="false"
        inputMode="text"
        enterKeyHint="enter"
        disabled={disabled}
      />
      <div className="mobile-input-actions">
        <button type="submit" disabled={disabled}>Enter</button>
        <button type="button" onClick={onSend} disabled={disabled || !value}>Type</button>
        <button type="button" onClick={onSpace} disabled={disabled}>Space</button>
        <button type="button" onClick={onBackspace} disabled={disabled}>Bksp</button>
        <button type="button" onClick={onClear} disabled={disabled || !value}>Clear</button>
      </div>
      {error && <p className="mobile-input-error">{error}</p>}
    </form>
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
  const [terminalFontSize, setTerminalFontSize] = useState(resolveStoredFontSize)
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
  const [terminalDraft, setTerminalDraft] = useState('')
  const [terminalInputError, setTerminalInputError] = useState('')
  const [agentActionKey, setAgentActionKey] = useState('')
  const [agentActionError, setAgentActionError] = useState('')
  const terminalBridgeRef = useRef(null)
  const voiceRecorderRef = useRef(null)
  const voiceRecognitionRef = useRef(null)
  const voiceStreamRef = useRef(null)
  const voiceChunksRef = useRef([])
  const voiceRecordingStartedAtRef = useRef(0)

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

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const root = window.document.documentElement
    const updateHeight = () => {
      const height = window.visualViewport?.height || window.innerHeight
      if (height > 0) {
        root.style.setProperty('--mobile-terminal-height', `${height}px`)
      }
    }
    updateHeight()
    window.addEventListener('resize', updateHeight)
    window.visualViewport?.addEventListener('resize', updateHeight)
    window.visualViewport?.addEventListener('scroll', updateHeight)
    return () => {
      window.removeEventListener('resize', updateHeight)
      window.visualViewport?.removeEventListener('resize', updateHeight)
      window.visualViewport?.removeEventListener('scroll', updateHeight)
      root.style.removeProperty('--mobile-terminal-height')
    }
  }, [])

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

  const updateWorkspaceAgents = useCallback((workspaceKey, agents) => {
    if (!agents) {
      return
    }
    setHosts((currentHosts) => currentHosts.map((host) => ({
      ...host,
      workspaces: (host.workspaces || []).map((workspace) => (
        workspace.key === workspaceKey ? { ...workspace, agents } : workspace
      )),
    })))
  }, [])

  const handleToggleWorkspaceAgents = useCallback(async (workspace) => {
    if (!workspace?.agents?.count || agentActionKey) {
      return
    }
    const action = workspace.agents.status === 'parked' ? 'unpark' : 'park'
    setAgentActionKey(workspace.key)
    setAgentActionError('')
    try {
      const response = await fetch(
        `/api/mobile/agents/${encodeURIComponent(workspace.hostId)}/${encodeURIComponent(workspace.id)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        },
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload.error || `Unable to ${action} agents`)
      }
      updateWorkspaceAgents(workspace.key, payload.agents)
      await loadInventory()
    } catch (actionError) {
      setAgentActionError(actionError.message || `Unable to ${action} agents`)
    } finally {
      setAgentActionKey('')
    }
  }, [agentActionKey, loadInventory, updateWorkspaceAgents])

  const cleanupVoiceResources = useCallback(() => {
    if (voiceRecognitionRef.current) {
      const recognition = voiceRecognitionRef.current
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // ignore
      }
      voiceRecognitionRef.current = null
    }
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
    voiceRecordingStartedAtRef.current = 0
  }, [])

  const sendVoiceFileForTranscription = useCallback(async (blob, recordingMeta = {}) => {
    setVoicePending(true)
    setVoiceStatus('Transcribing...')
    setVoiceError('')
    try {
      let transcriptText = ''
      const audioType = blob.type || 'audio/webm'
      if (voiceService === VOICE_SERVICES.DEEPGRAM && DEEPGRAM_API_KEY) {
        const deepgramResponse = await fetch(
          `https://api.deepgram.com/v1/listen?model=nova-2&language=${voiceLanguage}&punctuate=true`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${DEEPGRAM_API_KEY}`,
              'Content-Type': audioType,
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
        formData.append('file', blob, `recording.${extensionForMimeType(audioType)}`)
        const whisperLanguage = normalizeWhisperLanguage(voiceLanguage)
        if (whisperLanguage) {
          formData.append('language', whisperLanguage)
        }
        formData.append('translate', 'false')
        formData.append('vad_filter', 'false')
        const base = detectVoiceApiBase().replace(/\/$/, '')
        const response = await fetch(`${base}/transcribe`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          const message = await response.text()
          throw new Error(message || `Transcription service unavailable (${response.status})`)
        }
        const data = await response.json()
        transcriptText = data.text ?? ''
      }

      const trimmedTranscript = transcriptText.trim()
      setVoiceTranscript(trimmedTranscript)
      setVoiceStatus(
        trimmedTranscript
          ? 'Ready to send'
          : `No speech detected${formatRecordingDetails({ ...recordingMeta, size: blob.size })}`,
      )
    } catch (transcriptionError) {
      setVoiceError(transcriptionError.message || 'Transcription failed')
      setVoiceStatus('')
    } finally {
      setVoicePending(false)
    }
  }, [voiceLanguage, voiceService])

  const startBrowserSpeechRecognition = useCallback(() => {
    const Recognition = getSpeechRecognitionConstructor()
    if (!Recognition) {
      return false
    }

    const recognition = new Recognition()
    let finalTranscript = ''
    let interimTranscript = ''
    recognition.lang = voiceLanguage || 'pt-BR'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onresult = (event) => {
      interimTranscript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index]?.[0]?.transcript ?? ''
        if (event.results[index].isFinal) {
          finalTranscript += text
        } else {
          interimTranscript += text
        }
      }
      const visibleTranscript = `${finalTranscript} ${interimTranscript}`.trim()
      setVoiceTranscript(visibleTranscript)
      setVoiceStatus(visibleTranscript ? 'Listening...' : 'Listening for speech...')
    }
    recognition.onerror = (event) => {
      voiceRecognitionRef.current = null
      setVoiceRecording(false)
      setVoicePending(false)
      setVoiceError(`Speech recognition failed: ${event.error || 'unknown error'}`)
      setVoiceStatus('')
    }
    recognition.onend = () => {
      if (voiceRecognitionRef.current === recognition) {
        voiceRecognitionRef.current = null
      }
      setVoiceRecording(false)
      const transcript = `${finalTranscript} ${interimTranscript}`.trim()
      setVoiceTranscript(transcript)
      setVoiceStatus(transcript ? 'Ready to send' : 'No speech detected by browser')
    }

    try {
      voiceRecognitionRef.current = recognition
      setVoiceTranscript('')
      setVoiceError('')
      setVoicePending(false)
      setVoiceRecording(true)
      setVoiceStatus('Listening for speech...')
      recognition.start()
      return true
    } catch (error) {
      voiceRecognitionRef.current = null
      setVoiceRecording(false)
      setVoiceError(error.message || 'Unable to start browser speech recognition.')
      setVoiceStatus('')
      return true
    }
  }, [voiceLanguage])

  const startRecording = useCallback(async () => {
    if (!isSecureContext) {
      setVoiceError('Microphone requires HTTPS or localhost.')
      return
    }
    cleanupVoiceResources()
    if (startBrowserSpeechRecognition()) {
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
      const mimeType = pickRecorderMimeType()
      const recorder = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream)
      voiceChunksRef.current = []
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data)
        }
      })
      recorder.addEventListener('start', () => {
        voiceRecordingStartedAtRef.current = Date.now()
        setVoiceRecording(true)
        setVoiceStatus('Recording...')
      })
      recorder.addEventListener('stop', async () => {
        setVoiceRecording(false)
        const recordingMs = voiceRecordingStartedAtRef.current
          ? Date.now() - voiceRecordingStartedAtRef.current
          : 0
        const audioType = recorder.mimeType || mimeType || 'audio/webm'
        const blobData = new Blob(voiceChunksRef.current, { type: audioType })
        cleanupVoiceResources()
        if (!blobData.size) {
          setVoiceError('No audio captured.')
          setVoiceStatus('')
          return
        }
        await sendVoiceFileForTranscription(blobData, { recordingMs })
      })
      recorder.start()
      voiceRecorderRef.current = recorder
    } catch (recordError) {
      setVoiceError(recordError.message || 'Unable to access microphone.')
      cleanupVoiceResources()
    }
  }, [cleanupVoiceResources, isSecureContext, sendVoiceFileForTranscription, startBrowserSpeechRecognition])

  const stopRecording = useCallback(() => {
    if (voiceRecognitionRef.current) {
      try {
        voiceRecognitionRef.current.stop()
      } catch {
        cleanupVoiceResources()
      }
      return
    }
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

  const sendTerminalInput = useCallback((payload) => {
    if (!payload) {
      return true
    }
    const bridge = terminalBridgeRef.current
    if (!bridge?.sendInput?.(payload)) {
      setTerminalInputError('Terminal connection is not ready.')
      return false
    }
    setTerminalInputError('')
    return true
  }, [])

  const sendTerminalDraft = useCallback(() => {
    const text = terminalDraft
    if (!text) {
      return
    }
    if (sendTerminalInput(text)) {
      setTerminalDraft('')
    }
  }, [sendTerminalInput, terminalDraft])

  const sendTerminalEnter = useCallback(() => {
    const payload = terminalDraft ? `${terminalDraft}\r` : '\r'
    if (sendTerminalInput(payload)) {
      setTerminalDraft('')
    }
  }, [sendTerminalInput, terminalDraft])

  const appendTerminalSpace = useCallback(() => {
    setTerminalDraft((current) => `${current} `)
  }, [])

  const handleTerminalBackspace = useCallback(() => {
    setTerminalDraft((current) => {
      if (current.length > 0) {
        return current.slice(0, -1)
      }
      sendTerminalInput('\x7f')
      return current
    })
  }, [sendTerminalInput])

  const sendTranscript = useCallback(() => {
    const text = voiceTranscript.trim()
    if (!text) {
      return
    }
    if (!sendTerminalInput(`${text}\r`)) {
      setVoiceError('Terminal connection is not ready.')
      return
    }
    setVoiceTranscript('')
    setVoiceError('')
    setVoiceStatus('Sent')
  }, [sendTerminalInput, voiceTranscript])

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
          showShortcutBar={false}
          disableKeyboardInput
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

      {canShowTerminal && (
        <MobileInputDock
          value={terminalDraft}
          disabled={!canShowTerminal}
          error={terminalInputError}
          onChange={setTerminalDraft}
          onSend={sendTerminalDraft}
          onEnter={sendTerminalEnter}
          onSpace={appendTerminalSpace}
          onBackspace={handleTerminalBackspace}
          onClear={() => setTerminalDraft('')}
        />
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
            onToggleAgents={handleToggleWorkspaceAgents}
            agentActionKey={agentActionKey}
            agentActionError={agentActionError}
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
          onToggleAgents={handleToggleWorkspaceAgents}
          agentActionKey={agentActionKey}
          agentActionError={agentActionError}
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
