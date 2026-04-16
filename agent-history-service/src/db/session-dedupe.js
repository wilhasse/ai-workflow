function toMillis(value) {
  if (!value) return 0
  const millis = new Date(value).getTime()
  return Number.isNaN(millis) ? 0 : millis
}

function newestNonEmpty(rows, field) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index][field]
    if (value != null && value !== '') return value
  }
  return null
}

export function canonicalizeSessionGroup(rows) {
  if (!rows.length) {
    throw new Error('canonicalizeSessionGroup requires at least one row')
  }

  const ordered = [...rows].sort((left, right) => toMillis(left.started_at) - toMillis(right.started_at))
  const first = ordered[0]

  return {
    session_id: first.session_id,
    vm_id: first.vm_id,
    source: first.source,
    started_at: first.started_at,
    project: newestNonEmpty(ordered, 'project'),
    display_text: newestNonEmpty(ordered, 'display_text'),
    session_meta: newestNonEmpty(ordered, 'session_meta'),
    message_count: ordered.reduce((max, row) => Math.max(max, Number(row.message_count) || 0), 0),
    last_synced_at: ordered.reduce((latest, row) => toMillis(row.last_synced_at) > toMillis(latest) ? row.last_synced_at : latest, ordered[0].last_synced_at),
  }
}

export function collapseSessionRows(rows) {
  const groups = new Map()

  for (const row of rows) {
    const key = [row.session_id, row.vm_id, row.source].join('::')
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      groups.set(key, [row])
    }
  }

  return [...groups.values()].map(canonicalizeSessionGroup)
}
