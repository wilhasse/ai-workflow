import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import readline from 'node:readline'
import WebSocket from 'ws'

const safeMessage = (error) => error instanceof Error ? error.message : String(error)

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.bin = options.bin || 'codex'
    this.args = options.args || ['app-server']
    this.url = options.url || ''
    this.tokenFile = options.tokenFile || ''
    this.cwd = options.cwd
    this.env = options.env || process.env
    this.requestTimeoutMs = options.requestTimeoutMs || 30000
    this.child = null
    this.socket = null
    this.ready = false
    this.startPromise = null
    this.nextId = 1
    this.pending = new Map()
    this.stderr = []
    this.lastError = ''
  }

  get status() {
    return {
      ready: this.ready,
      pid: this.child?.pid || null,
      transport: this.url ? 'websocket' : 'stdio',
      lastError: this.lastError,
    }
  }

  async start() {
    if (this.ready) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#startTransport()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async #startTransport() {
    this.lastError = ''
    try {
      if (this.url) await this.#startWebSocket()
      else this.#startProcess()
      await this.#requestDirect('initialize', {
        clientInfo: {
          name: 'ai_workflow_agent_board',
          title: 'AI Workflow Agent Board',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
        },
      })
      this.notify('initialized', {})
      this.ready = true
      this.emit('ready')
    } catch (error) {
      this.lastError = safeMessage(error)
      await this.stop()
      throw error
    }
  }

  #startProcess() {
    const child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    const output = readline.createInterface({ input: child.stdout })
    output.on('line', (line) => this.#handleLine(line))
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      this.stderr.push(text)
      this.stderr = this.stderr.slice(-20)
      this.emit('stderr', text)
    })
    child.once('error', (error) => this.#handleExit(error))
    child.once('exit', (code, signal) => {
      this.#handleExit(new Error(`codex app-server exited (${signal || code})`))
    })
  }

  async #startWebSocket() {
    const token = (await fs.readFile(this.tokenFile, 'utf8')).trim()
    if (!token) throw new Error('Codex app-server token file is empty')
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    this.socket = socket
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off('open', handleOpen)
        socket.off('error', handleError)
        socket.off('close', handleClose)
      }
      const handleOpen = () => {
        cleanup()
        resolve()
      }
      const handleError = (error) => {
        cleanup()
        reject(error)
      }
      const handleClose = (code, reason) => {
        cleanup()
        reject(new Error(`codex app-server websocket closed (${code}: ${reason.toString('utf8')})`))
      }
      socket.once('open', handleOpen)
      socket.once('error', handleError)
      socket.once('close', handleClose)
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('protocolError', new Error('app-server emitted a binary WebSocket message'))
        return
      }
      this.#handleLine(data.toString('utf8'))
    })
    socket.on('error', (error) => {
      if (this.socket !== socket) return
      socket.terminate()
      this.#handleExit(error)
    })
    socket.on('close', (code, reason) => {
      this.#handleExit(new Error(`codex app-server websocket closed (${code}: ${reason.toString('utf8')})`))
    })
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.emit('protocolError', new Error('app-server emitted invalid JSON'))
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(String(message.id))
      if (message.error) {
        const error = new Error(message.error.message || 'app-server request failed')
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method && message.id !== undefined) {
      this.emit('serverRequest', message)
      return
    }
    if (message.method) this.emit('notification', message)
  }

  #write(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
      return
    }
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
      return
    }
    throw new Error('codex app-server is not writable')
  }

  #requestDirect(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`app-server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(String(id), { resolve, reject, timer, method })
      try {
        this.#write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(String(id))
        reject(error)
      }
    })
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    await this.start()
    return this.#requestDirect(method, params, timeoutMs)
  }

  notify(method, params = {}) {
    this.#write({ method, params })
  }

  respond(id, result) {
    this.#write({ id, result })
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } })
  }

  #handleExit(error) {
    if (this.child === null && this.socket === null && !this.ready) return
    this.lastError = safeMessage(error)
    this.ready = false
    this.child = null
    this.socket = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('exit', error)
  }

  async stop() {
    const child = this.child
    const socket = this.socket
    this.ready = false
    this.child = null
    this.socket = null
    const error = new Error('codex app-server client stopped')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000)
    else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate()
    if (child) {
      child.stdin.end()
      child.kill('SIGTERM')
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}
