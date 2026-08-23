export default {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '5002', 10),
  // Bearer token required for every endpoint except /health.
  // Empty means auth disabled (only acceptable on a trusted network).
  apiToken: process.env.API_TOKEN ?? '',
  mysql: {
    host: process.env.MYSQL_HOST ?? '10.0.0.36',
    port: Number.parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.MYSQL_USER ?? 'agent_history',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'agent_history',
    connectionLimit: 5,
    connectTimeout: 15000,
  },
  summary: {
    baseUrl: process.env.SUMMARY_BASE_URL ?? 'https://cliproxyapi.cslog.com.br/v1',
    apiKey: process.env.SUMMARY_API_KEY ?? '',
    model: process.env.SUMMARY_MODEL ?? 'kimi-k3',
    batch: Number.parseInt(process.env.SUMMARY_BATCH ?? '10', 10),
    dryRun: process.env.SUMMARY_DRY_RUN === '1',
    // 'codex' by default (per CSLOG-166 request); '' summarizes all sources.
    source: process.env.SUMMARY_SOURCE ?? 'codex',
    // Bulk mode: 0 = loop until no candidates remain; 1 = single pass.
    loops: Number.parseInt(process.env.SUMMARY_LOOPS ?? '1', 10),
    concurrency: Number.parseInt(process.env.SUMMARY_CONCURRENCY ?? '4', 10),
  },
}
