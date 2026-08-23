import http from 'node:http'
import { InputError } from './presets.js'

const json = (res, statusCode, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

const readBody = async (req, maxBytes) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new InputError('Request body is too large', 413)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new InputError('Request body must be valid JSON')
  }
}

const match = (pathname, expression) => pathname.match(expression)?.slice(1).map(decodeURIComponent)

export const createHttpServer = ({ control, config }) => {
  const sseClients = new Set()
  const broadcast = (event) => {
    const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) client.write(payload)
  }
  control.on('event', broadcast)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    try {
      if (req.method === 'GET' && pathname === '/health') {
        const health = control.health()
        json(res, health.ok ? 200 : 503, health)
        return
      }
      if (req.method === 'GET' && pathname === '/presets') {
        json(res, 200, { presets: control.presets() })
        return
      }
      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(`event: snapshot\ndata: ${JSON.stringify(control.snapshot())}\n\n`)
        sseClients.add(res)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)
        req.on('close', () => {
          clearInterval(heartbeat)
          sseClients.delete(res)
        })
        return
      }
      if (req.method === 'GET' && pathname === '/threads') {
        const threads = url.searchParams.get('refresh') === '1'
          ? await control.refreshThreads()
          : control.listCachedThreads()
        json(res, 200, { threads, approvals: control.listApprovals() })
        return
      }
      if (req.method === 'POST' && pathname === '/threads') {
        json(res, 201, await control.createThread(await readBody(req, config.maxBodyBytes)))
        return
      }
      let params = match(pathname, /^\/threads\/([^/]+)$/)
      if (req.method === 'GET' && params) {
        json(res, 200, { thread: await control.readThread(params[0]) })
        return
      }
      params = match(pathname, /^\/threads\/([^/]+)\/resume$/)
      if (req.method === 'POST' && params) {
        json(res, 200, { thread: await control.resumeThread(params[0]) })
        return
      }
      params = match(pathname, /^\/threads\/([^/]+)\/turns$/)
      if (req.method === 'POST' && params) {
        json(res, 201, { turn: await control.startTurn(params[0], await readBody(req, config.maxBodyBytes)) })
        return
      }
      params = match(pathname, /^\/threads\/([^/]+)\/steer$/)
      if (req.method === 'POST' && params) {
        json(res, 200, await control.steerTurn(params[0], await readBody(req, config.maxBodyBytes)))
        return
      }
      params = match(pathname, /^\/threads\/([^/]+)\/interrupt$/)
      if (req.method === 'POST' && params) {
        json(res, 200, await control.interruptTurn(params[0], await readBody(req, config.maxBodyBytes)))
        return
      }
      if (req.method === 'GET' && pathname === '/approvals') {
        json(res, 200, { approvals: control.listApprovals() })
        return
      }
      params = match(pathname, /^\/approvals\/([^/]+)$/)
      if (req.method === 'POST' && params) {
        json(res, 200, control.resolveApproval(params[0], await readBody(req, config.maxBodyBytes)))
        return
      }
      if (req.method === 'POST' && pathname === '/compare') {
        json(res, 202, { comparison: await control.startComparison(await readBody(req, config.maxBodyBytes)) })
        return
      }
      params = match(pathname, /^\/comparisons\/([^/]+)$/)
      if (req.method === 'GET' && params) {
        json(res, 200, { comparison: control.getComparison(params[0]) })
        return
      }
      json(res, 404, { error: 'Not found' })
    } catch (error) {
      const statusCode = error?.statusCode || 500
      json(res, statusCode, { error: error?.message || 'Internal server error' })
    }
  })

  server.on('close', () => control.off('event', broadcast))
  return server
}
