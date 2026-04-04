export default {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '5002', 10),
  doris: {
    host: process.env.DORIS_HOST ?? '10.1.0.7',
    port: Number.parseInt(process.env.DORIS_PORT ?? '9030', 10),
    user: process.env.DORIS_USER ?? 'root',
    password: process.env.DORIS_PASSWORD ?? '',
    database: process.env.DORIS_DATABASE ?? 'agent_history',
    connectionLimit: 10,
    connectTimeout: 10000,
  },
}
