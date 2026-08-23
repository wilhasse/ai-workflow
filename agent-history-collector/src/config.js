import os from 'node:os'

export default {
  apiUrl: process.env.API_URL ?? 'http://10.1.0.7:5002',
  apiToken: process.env.API_TOKEN ?? '',
  // Optional second ingest target (e.g. the OCI MySQL service). When set,
  // every batch is sent to both targets; a failure on either retries both
  // on the next cycle (ingest upserts are idempotent).
  ociApiUrl: process.env.OCI_API_URL ?? '',
  ociApiToken: process.env.OCI_API_TOKEN ?? '',
  vmId: process.env.VM_ID ?? os.hostname(),
  claudeHome: process.env.CLAUDE_HOME ?? `${os.homedir()}/.claude`,
  codexHome: process.env.CODEX_HOME ?? `${os.homedir()}/.codex`,
  syncIntervalMs: Number.parseInt(process.env.SYNC_INTERVAL_MS ?? '300000', 10),
  dataDir: process.env.DATA_DIR ?? `${os.homedir()}/.agent-history-collector`,
  batchSize: 500,
}
