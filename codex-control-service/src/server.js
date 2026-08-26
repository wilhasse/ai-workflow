import { AppServerClient } from './app-server-client.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { ControlService } from './control-service.js'
import { createHttpServer } from './http-server.js'

const config = loadConfig()
const client = new AppServerClient({
  url: config.appServerUrl,
  tokenFile: config.appServerTokenFile,
  bin: config.codexBin,
  args: config.codexArgs,
  cwd: config.defaultCwd,
  requestTimeoutMs: config.requestTimeoutMs,
})
const control = new ControlService({ client, config })
const server = createHttpServer({ control, config })

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  server.close()
  server.closeAllConnections?.()
  await control.stop()
  process.exit(0)
}

const prepareSocket = async () => {
  if (!config.socketPath) return
  await fs.mkdir(path.dirname(config.socketPath), { recursive: true })
  try {
    const entry = await fs.lstat(config.socketPath)
    if (!entry.isSocket()) throw new Error(`Refusing to replace non-socket path: ${config.socketPath}`)
    await fs.unlink(config.socketPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

try {
  await control.start()
  await prepareSocket()
  const listenTarget = config.socketPath || config.port
  const listenHost = config.socketPath ? undefined : config.host
  server.listen(listenTarget, listenHost, async () => {
    if (config.socketPath) {
      await fs.chmod(config.socketPath, 0o666)
      process.stdout.write(`codex-control-service listening on ${config.socketPath}\n`)
    } else {
      process.stdout.write(`codex-control-service listening on ${config.host}:${config.port}\n`)
    }
  })
} catch (error) {
  process.stderr.write(`codex-control-service failed to start: ${error.message}\n`)
  await control.stop()
  process.exitCode = 1
}
