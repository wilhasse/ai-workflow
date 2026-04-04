import http from 'node:http'
import config from './config.js'
import { ensureSchema } from './db/schema.js'
import { route } from './api/routes.js'

const defaultHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, defaultHeaders)
    res.end()
    return
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {}
    const result = await route(req.method, req.url, body)
    res.writeHead(result.status, defaultHeaders)
    res.end(JSON.stringify(result.body))
  } catch (err) {
    console.error('[server] error:', err.message)
    res.writeHead(500, defaultHeaders)
    res.end(JSON.stringify({ ok: false, error: err.message }))
  }
})

async function start() {
  console.log('[server] ensuring schema...')
  await ensureSchema()
  console.log('[server] schema ready')

  server.listen(config.port, config.host, () => {
    console.log(`[server] listening on ${config.host}:${config.port}`)
  })
}

start().catch(err => {
  console.error('[server] startup failed:', err)
  process.exit(1)
})
