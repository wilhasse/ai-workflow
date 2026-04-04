import os from 'node:os'

export default {
  apiUrl: process.env.API_URL ?? 'http://10.1.0.7:5002',
  vmId: process.env.VM_ID ?? os.hostname(),
  claudeHome: process.env.CLAUDE_HOME ?? `${os.homedir()}/.claude`,
  codexHome: process.env.CODEX_HOME ?? `${os.homedir()}/.codex`,
  syncIntervalMs: Number.parseInt(process.env.SYNC_INTERVAL_MS ?? '300000', 10),
  dataDir: process.env.DATA_DIR ?? `${os.homedir()}/.agent-history-collector`,
  batchSize: 500,
}
