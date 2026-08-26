import os from 'node:os'
import path from 'node:path'

const splitList = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const loadConfig = (env = process.env) => {
  const home = os.homedir()
  const defaultWorkspace = path.join(home, 'ai-workflow')
  const allowedRoots = splitList(env.CODEX_CONTROL_ALLOWED_ROOTS)

  return {
    host: env.CODEX_CONTROL_HOST || '127.0.0.1',
    port: positiveInteger(env.CODEX_CONTROL_PORT, 5006),
    socketPath: env.CODEX_CONTROL_SOCKET ? path.resolve(env.CODEX_CONTROL_SOCKET) : '',
    appServerUrl: env.CODEX_CONTROL_APP_SERVER_URL || '',
    appServerTokenFile: env.CODEX_CONTROL_APP_SERVER_TOKEN_FILE
      ? path.resolve(env.CODEX_CONTROL_APP_SERVER_TOKEN_FILE)
      : '',
    codexBin: env.CODEX_CONTROL_CODEX_BIN || 'codex',
    codexArgs: splitList(env.CODEX_CONTROL_CODEX_ARGS).length
      ? splitList(env.CODEX_CONTROL_CODEX_ARGS)
      : ['app-server'],
    defaultCwd: path.resolve(env.CODEX_CONTROL_DEFAULT_CWD || defaultWorkspace),
    allowedRoots: (allowedRoots.length ? allowedRoots : [home]).map((root) => path.resolve(root)),
    archivePath: path.resolve(
      env.CODEX_CONTROL_ARCHIVE_PATH
        || path.join(home, '.local', 'state', 'ai-workflow', 'workspace-session-archive.json'),
    ),
    requestTimeoutMs: positiveInteger(env.CODEX_CONTROL_REQUEST_TIMEOUT_MS, 30000),
    comparisonTimeoutMs: positiveInteger(env.CODEX_CONTROL_COMPARISON_TIMEOUT_MS, 600000),
    refreshIntervalMs: positiveInteger(env.CODEX_CONTROL_REFRESH_INTERVAL_MS, 30000),
    maxEvents: positiveInteger(env.CODEX_CONTROL_MAX_EVENTS, 500),
    maxThreads: positiveInteger(env.CODEX_CONTROL_MAX_THREADS, 300),
    maxBodyBytes: positiveInteger(env.CODEX_CONTROL_MAX_BODY_BYTES, 256 * 1024),
  }
}
