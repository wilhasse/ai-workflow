import { useCallback, useEffect, useRef, useState } from 'react'
import { listTranscripts } from '../api/transcribe'

const POLL_MS = 3000
const ACTIVE = new Set(['queued', 'processing'])

export function useTranscripts(enabled) {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const timer = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const rows = await listTranscripts()
      setItems(rows)
      setError('')
      return rows
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false

    const tick = async () => {
      const rows = await refresh()
      if (cancelled) return
      const anyActive = rows.some((r) => ACTIVE.has(r.status))
      if (anyActive) {
        timer.current = setTimeout(tick, POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, refresh])

  return { items, error, refresh, setItems }
}
