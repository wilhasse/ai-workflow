import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)
const COOKIE = '__Host-history'
const COST = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const HASH_PATTERN = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw new Error('Password must contain 16 to 1024 characters')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, COST)
  return `scrypt$32768$8$1$${salt}$${hash.toString('hex')}`
}

export function sameSecret(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function result(status, body, headers = {}) {
  return { status, body, headers }
}

export function createBrowserAuth(settings, { now = Date.now, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const { username = '', passwordHash = '', origin = '' } = settings ?? {}
  if (!username && !passwordHash && !origin) return null
  let parsedOrigin
  try { parsedOrigin = new URL(origin) } catch { throw new Error('HISTORY_ORIGIN must be an HTTPS origin') }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) {
    throw new Error('HISTORY_ORIGIN must be an HTTPS origin without a path')
  }
  const hashParts = passwordHash.match(HASH_PATTERN)
  if (!username.trim() || username.length > 128 || !hashParts) {
    throw new Error('Configure HISTORY_USERNAME and a valid scrypt HISTORY_PASSWORD_HASH')
  }
  const sessions = new Map()
  const attempts = new Map()
  let activeChecks = 0
  let globalWindow = { until: 0, count: 0 }
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
  const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex')

  function sessionKey(req) {
    const value = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    return value && /^[a-f0-9]{64}$/.test(value) ? tokenHash(value) : null
  }

  function authenticated(req) {
    const key = sessionKey(req)
    const expires = key && sessions.get(key)
    if (!expires) return false
    if (expires <= now()) { sessions.delete(key); return false }
    return true
  }

  function allowAttempt(req) {
    const time = now()
    for (const [key, entry] of attempts) if (entry.until <= time) attempts.delete(key)
    if (globalWindow.until <= time) globalWindow = { until: time + 60_000, count: 0 }
    if (globalWindow.count >= 30 || activeChecks >= 2) return false
    // Use the socket address, never a spoofable forwarded header. Caddy shares one
    // bucket; this personal archive intentionally has a conservative global cap.
    const key = req.socket.remoteAddress ?? 'unknown'
    const entry = attempts.get(key) ?? { until: time + 5 * 60_000, count: 0 }
    if (entry.count >= 10 || (!attempts.has(key) && attempts.size >= 1024)) return false
    entry.count++
    attempts.set(key, entry)
    globalWindow.count++
    return true
  }

  async function handle(req, body = {}) {
    const path = req.url.split('?')[0]
    if (!['/auth/login', '/auth/logout', '/auth/session'].includes(path)) return null
    if (path === '/auth/session' && req.method === 'GET') {
      return authenticated(req)
        ? result(200, { ok: true, data: { username } })
        : result(401, { ok: false, error: 'Please sign in' })
    }
    if (req.method !== 'POST' || path === '/auth/session') return result(405, { ok: false, error: 'Method not allowed' })
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return result(403, { ok: false, error: 'Invalid request origin or content type' })
    }
    if (path === '/auth/logout') {
      sessions.delete(sessionKey(req))
      return result(200, { ok: true }, { 'Set-Cookie': cookie('', 0) })
    }
    if (typeof body?.username !== 'string' || body.username.length > 128 || typeof body?.password !== 'string' || body.password.length > 1024) {
      return result(400, { ok: false, error: 'Enter a valid username and password' })
    }
    if (!allowAttempt(req)) return result(429, { ok: false, error: 'Too many sign-in attempts. Try again in five minutes.' }, { 'Retry-After': '300' })
    activeChecks++
    let correctPassword
    try {
      const actual = await scrypt(body.password, Buffer.from(hashParts[1], 'hex'), 64, COST)
      correctPassword = crypto.timingSafeEqual(actual, Buffer.from(hashParts[2], 'hex'))
    } finally { activeChecks-- }
    if (!correctPassword || !sameSecret(body.username, username)) return result(401, { ok: false, error: 'Incorrect username or password' })
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key)
    sessions.delete(sessionKey(req))
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value)
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(tokenHash(token), now() + ttlMs)
    return result(200, { ok: true, data: { username } }, { 'Set-Cookie': cookie(token, Math.floor(ttlMs / 1000)) })
  }

  return { authenticated, handle }
}
