import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

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

export default TerminalViewer
