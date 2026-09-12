import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import config from './config.js'
import { createBrowserAuth, sameSecret } from './auth.js'

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
const browserPrefix = '/api/agent-history'
const readRoutes = /^\/(?:health|search|sessions|history|tasks|stats|sync\/status|sessions\/[^/?]+(?:\/messages|\/handoff)?)$/

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let exceeded = false
    const tooLarge = () => {
      exceeded = true
      chunks.length = 0
      reject(Object.assign(new Error('Request body too large'), { status: 413 }))
    }
    if (Number(req.headers['content-length']) > limit) { req.resume(); tooLarge(); return }
    req.on('data', chunk => {
      if (exceeded) return
      size += chunk.length
      if (size > limit) { tooLarge(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (exceeded) return
      if (!size) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
    req.on('error', () => reject(Object.assign(new Error('Could not read request'), { status: 400 })))
    req.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { status: 400 })))
  })
}

export function createServer({ route, settings = config, browserAuth, maxBodyBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof settings.apiToken !== 'string' || settings.apiToken.trim().length < 24) {
    throw new Error('API_TOKEN must contain at least 24 characters')
  }
  if (typeof route !== 'function') throw new Error('An API route handler is required')
  const auth = browserAuth === undefined ? createBrowserAuth(settings.history) : browserAuth
  const assets = new Map()
  if (auth) {
    for (const [path, name, type] of [
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
      ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
      ['/icon.svg', 'icon.svg', 'image/svg+xml'],
    ]) assets.set(path, { raw: readFileSync(new URL(`./public/${name}`, import.meta.url)), contentType: type })
  }
  return http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16_384 }, async (req, res) => {
    const send = ({ status = 200, body, raw, contentType, headers: extra = {} }) => {
      res.writeHead(status, { ...headers, ...(status === 413 ? { Connection: 'close' } : {}), ...(contentType ? { 'Content-Type': contentType } : {}), ...extra })
      res.end(raw ?? JSON.stringify(body))
    }
    try {
      const path = req.url.split('?')[0]
      if (req.method === 'GET' && assets.has(path)) { send(assets.get(path)); return }
      if (path.startsWith('/auth/')) {
        if (!auth) { send({ status: 404, body: { ok: false, error: 'Not found' } }); return }
        const body = req.method === 'POST' ? await readBody(req, 4096) : {}
        send(await auth.handle(req, body) ?? { status: 404, body: { ok: false, error: 'Not found' } })
        return
      }
      if (path === '/health' && req.method === 'GET') {
        const result = await route('GET', '/health', {})
        send({ status: result.status, body: { ok: result.status === 200 } })
        return
      }
      let url = req.url
      if (path === browserPrefix || path.startsWith(`${browserPrefix}/`)) {
        if (!auth?.authenticated(req)) { send({ status: 401, body: { ok: false, error: 'Please sign in' } }); return }
        url = req.url.slice(browserPrefix.length)
        if (req.method !== 'GET' || !readRoutes.test(url.split('?')[0])) {
          send({ status: 403, body: { ok: false, error: 'Browser access is read-only' } })
          return
        }
      } else {
        const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
        if (!sameSecret(token, settings.apiToken)) { send({ status: 401, body: { ok: false, error: 'Unauthorized' } }); return }
      }
      const body = req.method === 'POST' ? await readBody(req, maxBodyBytes) : {}
      const result = await route(req.method, url, body)
      if (result.status >= 500) send({ status: result.status, body: { ok: false, error: 'The archive is temporarily unavailable. Please try again.' } })
      else send(result)
    } catch (err) {
      if (!err.status) console.error('[server] request failed:', err.code ?? err.name)
      send({ status: err.status ?? 500, body: { ok: false, error: err.status ? err.message : 'The archive is temporarily unavailable. Please try again.' } })
    }
  })
}

async function start() {
  const { route } = await import('./api/routes.js')
  const server = createServer({ route })
  const { ensureSchema } = await import('./db/schema.js')
  await ensureSchema()
  server.listen(config.port, config.host, () => console.log(`[server] listening on ${config.host}:${config.port}`))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch(err => {
    console.error('[server] startup failed:', err.message)
    process.exit(1)
  })
}
