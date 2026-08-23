import config from './config.js'

function targets() {
  const list = [{ url: config.apiUrl, token: config.apiToken }]
  if (config.ociApiUrl) list.push({ url: config.ociApiUrl, token: config.ociApiToken })
  return list
}

async function sendTo(target, endpoint, records) {
  if (!records.length) return
  const url = `${target.url}/ingest/${endpoint}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
    },
    body: JSON.stringify({ records }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST ${endpoint} -> ${target.url} failed (${res.status}): ${text}`)
  }
  return res.json()
}

export async function send(endpoint, records) {
  if (!records.length) return
  // Fan out to every target; collect failures and throw at the end so the
  // collector retries the batch for all targets on the next cycle.
  const errors = []
  for (const target of targets()) {
    try {
      await sendTo(target, endpoint, records)
    } catch (err) {
      console.error(`[sender] ${err.message}`)
      errors.push(err)
    }
  }
  if (errors.length) throw errors[0]
}

export async function sendBatched(endpoint, records) {
  for (let i = 0; i < records.length; i += config.batchSize) {
    const batch = records.slice(i, i + config.batchSize)
    await send(endpoint, batch)
  }
}
