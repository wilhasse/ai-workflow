import crypto from 'node:crypto'

function utcSecond(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 19)
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) return text.replace(' ', 'T').slice(0, 19)
  const date = new Date(text)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid message timestamp in verification')
  return date.toISOString().slice(0, 19)
}

export function messageManifest(rows) {
  const entries = new Map()
  for (const row of rows) {
    const identity = [row.message_id, row.session_id, row.vm_id, utcSecond(row.ts ?? row.timestamp)]
    if (identity.some(value => typeof value !== 'string' || !value)) throw new Error('Incomplete message identity in verification')
    const key = JSON.stringify(identity)
    if (entries.has(key)) throw new Error('Duplicate message primary key in verification response')
    entries.set(key, crypto.createHash('sha256').update(JSON.stringify(row.content_text ?? null)).digest('hex'))
  }
  return entries
}

export function manifestDigest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify([...manifest].sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
}

export function compareManifests(source, cloud) {
  const missing = []
  const changed = []
  for (const [key, hash] of source) {
    if (!cloud.has(key)) missing.push(key)
    else if (cloud.get(key) !== hash) changed.push(key)
  }
  return {
    sourceMessages: source.size, cloudMessages: cloud.size,
    missingCount: missing.length, changedTextCount: changed.length,
    cloudOnlyCount: [...cloud.keys()].filter(key => !source.has(key)).length,
    missingKeys: missing.slice(0, 20).map(key => JSON.parse(key)),
    changedKeys: changed.slice(0, 20).map(key => JSON.parse(key)),
    sourceKeyTextSha256: manifestDigest(source),
    matched: missing.length === 0 && changed.length === 0,
  }
}
