import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

const SHORTCUTS_STORAGE_KEY = 'terminal-dashboard-shortcuts'

const DEFAULT_SHORTCUTS = [
  { id: 'ctrl-c', label: 'C-c', keys: '\x03', description: 'Interrupt (Ctrl+C)' },
  { id: 'ctrl-d', label: 'C-d', keys: '\x04', description: 'EOF (Ctrl+D)' },
  { id: 'ctrl-z', label: 'C-z', keys: '\x1a', description: 'Suspend (Ctrl+Z)' },
  { id: 'ctrl-l', label: 'C-l', keys: '\x0c', description: 'Clear (Ctrl+L)' },
  { id: 'tab', label: 'Tab', keys: '\t', description: 'Tab / Autocomplete' },
  { id: 'esc', label: 'Esc', keys: '\x1b', description: 'Escape' },
  { id: 'up', label: '↑', keys: '\x1b[A', description: 'Arrow Up' },
  { id: 'down', label: '↓', keys: '\x1b[B', description: 'Arrow Down' },
]

const loadShortcuts = () => {
  if (typeof window === 'undefined') return DEFAULT_SHORTCUTS
  try {
    const stored = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    }
  } catch (e) {
    console.warn('Failed to load shortcuts', e)
  }
  return DEFAULT_SHORTCUTS
}

const saveShortcuts = (shortcuts) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts))
  } catch (e) {
    console.warn('Failed to save shortcuts', e)
  }
}

function TerminalViewer({
  wsUrl,
  fontSize,
  onBridgeReady,
  showShortcutBar = true,
  monitorMode = false,
  onActivity,
}) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const socketRef = useRef(null)
  const fontSizeRef = useRef(fontSize)
  const [connectionState, setConnectionState] = useState({
    status: 'connecting',
    message: 'Connecting…',
  })
  const [shortcuts, setShortcuts] = useState(() => loadShortcuts())
  const [showShortcutConfig, setShowShortcutConfig] = useState(false)
  const [editingShortcut, setEditingShortcut] = useState(null)
  const [monitorScale, setMonitorScale] = useState(1)
  const lastActivityRef = useRef(0)
  const onActivityRef = useRef(onActivity)

  useEffect(() => {
    fontSizeRef.current = fontSize
  }, [fontSize])

  useEffect(() => {
    onActivityRef.current = onActivity
  }, [onActivity])

  const updateMonitorScale = useCallback(() => {
    if (!monitorMode) {
      return
    }
    const container = containerRef.current
    const term = termRef.current
    if (!container || !term) {
      return
    }
    const dimensions = term?._core?._renderService?.dimensions
    let width = 0
    let height = 0
    if (dimensions?.actualCellWidth && dimensions?.actualCellHeight) {
      width = term.cols * dimensions.actualCellWidth
      height = term.rows * dimensions.actualCellHeight
    } else {
      const screen = term.element?.querySelector('.xterm-screen')
      if (screen) {
        const rect = screen.getBoundingClientRect()
        width = rect.width
        height = rect.height
      }
    }
    if (!width || !height) {
      return
    }
    const scale = Math.min(
      container.clientWidth / width,
      container.clientHeight / height,
      1,
    )
    if (Number.isFinite(scale)) {
      setMonitorScale(scale)
    }
  }, [monitorMode])

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
      scrollback: 10000,
      smoothScrollDuration: 100,
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
    if (!monitorMode) {
      fitAddon.fit()
      term.focus()
    }
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
      if (monitorMode) {
        return
      }
      fitAddon.fit()
      sendMessage({ type: 'resize', cols: term.cols, rows: term.rows })
    }

    socket.addEventListener('open', () => {
      setConnectionState({ status: 'connected', message: 'Connected' })
      if (!monitorMode) {
        pushResize()
      }
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
        if (typeof onActivityRef.current === 'function') {
          const now = Date.now()
          if (now - lastActivityRef.current > 250) {
            lastActivityRef.current = now
            onActivityRef.current()
          }
        }
        term.write(payload.payload)
        return
      }
      if (payload.type === 'ready') {
        setConnectionState({ status: 'connected', message: 'Session ready' })
        if (monitorMode && Number.isFinite(payload.cols) && Number.isFinite(payload.rows)) {
          term.resize(payload.cols, payload.rows)
        }
        if (monitorMode) {
          updateMonitorScale()
        }
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

    const dataDisposable = monitorMode
      ? { dispose: () => {} }
      : term.onData((chunk) => {
          sendMessage({ type: 'input', payload: chunk })
        })

    let cleanupResize = () => {}
    if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
      const observer = new window.ResizeObserver(() => {
        if (monitorMode) {
          updateMonitorScale()
        } else {
          pushResize()
        }
      })
      observer.observe(container)
      cleanupResize = () => observer.disconnect()
    } else {
      const handleResize = () => {
        if (monitorMode) {
          updateMonitorScale()
        } else {
          pushResize()
        }
      }
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
  }, [wsUrl, monitorMode, updateMonitorScale])

  useEffect(() => {
    if (typeof onBridgeReady !== 'function') {
      return undefined
    }
    const bridge = {
      sendInput: (payload) => {
        if (monitorMode) {
          return false
        }
        if (!payload || typeof payload !== 'string') {
          return false
        }
        const target = socketRef.current
        if (target && target.readyState === window.WebSocket.OPEN) {
          target.send(
            JSON.stringify({
              type: 'input',
              payload,
            }),
          )
          return true
        }
        return false
      },
      isConnected: () => {
        const target = socketRef.current
        return !!target && target.readyState === window.WebSocket.OPEN
      },
    }
    onBridgeReady(bridge)
    return () => {
      onBridgeReady(null)
    }
  }, [monitorMode, onBridgeReady, wsUrl])

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
    if (monitorMode) {
      updateMonitorScale()
      return
    }
    fitAddonRef.current?.fit()
  }, [fontSize, monitorMode, updateMonitorScale])

  const sendShortcut = useCallback((keys) => {
    if (monitorMode) {
      return
    }
    const socket = socketRef.current
    if (socket && socket.readyState === window.WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', payload: keys }))
    }
    termRef.current?.focus()
  }, [monitorMode])

  const handleAddShortcut = useCallback((newShortcut) => {
    setShortcuts((prev) => {
      const updated = [...prev, { ...newShortcut, id: `custom-${Date.now()}` }]
      saveShortcuts(updated)
      return updated
    })
    setEditingShortcut(null)
  }, [])

  const handleRemoveShortcut = useCallback((id) => {
    setShortcuts((prev) => {
      const updated = prev.filter((s) => s.id !== id)
      saveShortcuts(updated)
      return updated
    })
  }, [])

  const handleResetShortcuts = useCallback(() => {
    setShortcuts(DEFAULT_SHORTCUTS)
    saveShortcuts(DEFAULT_SHORTCUTS)
  }, [])

  const handleMoveShortcut = useCallback((id, direction) => {
    setShortcuts((prev) => {
      const index = prev.findIndex((s) => s.id === id)
      if (index === -1) return prev
      const newIndex = direction === 'left' ? index - 1 : index + 1
      if (newIndex < 0 || newIndex >= prev.length) return prev
      const updated = [...prev]
      const temp = updated[index]
      updated[index] = updated[newIndex]
      updated[newIndex] = temp
      saveShortcuts(updated)
      return updated
    })
  }, [])

  const parseKeysInput = (input) => {
    return input
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n')
      .replace(/\\e/g, '\x1b')
      .replace(/\\033/g, '\x1b')
  }

  return (
    <div className="terminal-frame">
      {showShortcutBar && (
        <div className="terminal-shortcut-bar">
          <div className="shortcut-buttons">
            {shortcuts.map((shortcut) => (
              <button
                key={shortcut.id}
                type="button"
                className="shortcut-btn"
                onClick={() => sendShortcut(shortcut.keys)}
                title={shortcut.description}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="shortcut-config-btn"
            onClick={() => setShowShortcutConfig(!showShortcutConfig)}
            title="Configure shortcuts"
          >
            ⚙
          </button>
        </div>
      )}
      
      {showShortcutConfig && (
        <div className="shortcut-config-panel">
          <div className="shortcut-config-header">
            <span>Configure Shortcuts</span>
            <button type="button" onClick={() => setShowShortcutConfig(false)}>✕</button>
          </div>
          <div className="shortcut-config-list">
            {shortcuts.map((shortcut, index) => (
              <div key={shortcut.id} className="shortcut-config-item">
                <span className="shortcut-label">{shortcut.label}</span>
                <span className="shortcut-desc">{shortcut.description}</span>
                <div className="shortcut-actions">
                  <button
                    type="button"
                    onClick={() => handleMoveShortcut(shortcut.id, 'left')}
                    disabled={index === 0}
                    title="Move left"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveShortcut(shortcut.id, 'right')}
                    disabled={index === shortcuts.length - 1}
                    title="Move right"
                  >
                    →
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveShortcut(shortcut.id)}
                    title="Remove"
                    className="remove-btn"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
          
          {editingShortcut ? (
            <form
              className="shortcut-add-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (editingShortcut.label && editingShortcut.keys) {
                  handleAddShortcut({
                    label: editingShortcut.label,
                    keys: parseKeysInput(editingShortcut.keys),
                    description: editingShortcut.description || editingShortcut.label,
                  })
                }
              }}
            >
              <input
                type="text"
                placeholder="Label (e.g., C-a)"
                value={editingShortcut.label}
                onChange={(e) => setEditingShortcut((prev) => ({ ...prev, label: e.target.value }))}
                required
              />
              <input
                type="text"
                placeholder="Keys (e.g., \x01 or \e[A)"
                value={editingShortcut.keys}
                onChange={(e) => setEditingShortcut((prev) => ({ ...prev, keys: e.target.value }))}
                required
              />
              <input
                type="text"
                placeholder="Description"
                value={editingShortcut.description}
                onChange={(e) => setEditingShortcut((prev) => ({ ...prev, description: e.target.value }))}
              />
              <div className="form-actions">
                <button type="submit">Add</button>
                <button type="button" onClick={() => setEditingShortcut(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="shortcut-config-actions">
              <button
                type="button"
                onClick={() => setEditingShortcut({ label: '', keys: '', description: '' })}
              >
                + Add Shortcut
              </button>
              <button type="button" onClick={handleResetShortcuts}>
                Reset to Defaults
              </button>
            </div>
          )}
          
          <div className="shortcut-help">
            <p><strong>Key codes:</strong> \x03 = Ctrl+C, \x04 = Ctrl+D, \t = Tab, \e or \x1b = Escape</p>
            <p><strong>Arrows:</strong> \e[A = Up, \e[B = Down, \e[C = Right, \e[D = Left</p>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className={`terminal-surface${monitorMode ? ' terminal-surface-monitor' : ''}`}
        style={
          monitorMode
            ? { transform: `scale(${monitorScale})`, transformOrigin: 'top left' }
            : undefined
        }
      />
      <div className={`terminal-status terminal-status-${connectionState.status}`}>
        <span className="terminal-status-dot" />
        {connectionState.message}
      </div>
    </div>
  )
}

export default TerminalViewer
