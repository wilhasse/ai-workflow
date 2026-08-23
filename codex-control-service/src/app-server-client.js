import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'

const safeMessage = (error) => error instanceof Error ? error.message : String(error)

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.bin = options.bin || 'codex'
    this.args = options.args || ['app-server']
    this.cwd = options.cwd
    this.env = options.env || process.env
    this.requestTimeoutMs = options.requestTimeoutMs || 30000
    this.child = null
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
      lastError: this.lastError,
    }
  }

  async start() {
    if (this.ready) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#startProcess()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async #startProcess() {
    this.lastError = ''
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
    if (!this.child?.stdin?.writable) throw new Error('codex app-server is not writable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
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
    if (this.child === null && !this.ready) return
    this.lastError = safeMessage(error)
    this.ready = false
    this.child = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('exit', error)
  }

  async stop() {
    const child = this.child
    this.ready = false
    this.child = null
    if (!child) return
    child.stdin.end()
    child.kill('SIGTERM')
    child.stdout.destroy()
    child.stderr.destroy()
  }
}
