import { createRemoteTuiProxy } from './remote-tui-proxy.js'

const host = process.env.CODEX_REMOTE_PROXY_HOST || '127.0.0.1'
const port = Number(process.env.CODEX_REMOTE_PROXY_PORT || 4502)
const upstreamUrl = process.env.CODEX_REMOTE_PROXY_UPSTREAM_URL || 'ws://127.0.0.1:4500'
const proxy = createRemoteTuiProxy({ host, port, upstreamUrl })

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  await proxy.close()
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

try {
  await proxy.listen()
  process.stdout.write(`codex-remote-tui-proxy listening on ${host}:${port}\n`)
} catch (error) {
  process.stderr.write(`codex-remote-tui-proxy failed to start: ${error.message}\n`)
  process.exitCode = 1
}
