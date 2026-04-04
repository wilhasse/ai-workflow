import config from './config.js'

export async function send(endpoint, records) {
  if (!records.length) return
  const url = `${config.apiUrl}/ingest/${endpoint}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST ${endpoint} failed (${res.status}): ${text}`)
  }
  return res.json()
}

export async function sendBatched(endpoint, records) {
  for (let i = 0; i < records.length; i += config.batchSize) {
    const batch = records.slice(i, i + config.batchSize)
    await send(endpoint, batch)
  }
}
