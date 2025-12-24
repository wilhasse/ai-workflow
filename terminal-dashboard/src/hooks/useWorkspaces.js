import { useState, useEffect, useCallback, useRef } from 'react'

const POLL_INTERVAL = 30000 // 30 seconds

/**
 * Hook for fetching workspaces from the API.
 * Workspaces are read-only - managed by the GTK panel.
 */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState([])
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  const fetchWorkspaces = useCallback(async () => {
    try {
      const response = await fetch('/api/workspaces')
      if (!response.ok) {
        throw new Error(`Failed to fetch workspaces: ${response.status}`)
      }
      const data = await response.json()
      if (mountedRef.current) {
        setWorkspaces(data.workspaces || [])
        setSettings(data.settings || {})
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message)
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  const fetchWindows = useCallback(async (sessionId) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/windows`)
      if (!response.ok) {
        return []
      }
      const data = await response.json()
      return data.windows || []
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchWorkspaces()

    const interval = setInterval(fetchWorkspaces, POLL_INTERVAL)

    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [fetchWorkspaces])

  return {
    workspaces,
    settings,
    loading,
    error,
    refresh: fetchWorkspaces,
    fetchWindows,
  }
}
