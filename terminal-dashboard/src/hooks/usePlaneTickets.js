import { useCallback, useEffect, useState } from 'react'

const POLL_INTERVAL = 5000 // Poll every 5 seconds

// Use relative URL in production (nginx proxy) or localhost in development
const DAEMON_API_BASE =
  import.meta.env.MODE === 'production'
    ? '' // Relative URLs - nginx will proxy /api/* to plane-claude-orchestrator
    : 'http://localhost:5002' // Direct connection in dev mode

/**
 * Hook to poll the Plane orchestrator daemon for pending and completed tickets
 * @returns {Object} Ticket data and loading states
 */
export const usePlaneTickets = () => {
  const [pendingTickets, setPendingTickets] = useState([])
  const [completedTickets, setCompletedTickets] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [daemonHealthy, setDaemonHealthy] = useState(false)

  const fetchHealth = useCallback(async () => {
    try {
      // Use /orchestrator/health in production (nginx proxy), /health in dev
      const healthEndpoint = import.meta.env.MODE === 'production'
        ? '/orchestrator/health'
        : `${DAEMON_API_BASE}/health`
      const response = await fetch(healthEndpoint)
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`)
      }
      const data = await response.json()
      setDaemonHealthy(data.status === 'healthy' || data.status === 'degraded')
      return true
    } catch {
      setDaemonHealthy(false)
      return false
    }
  }, [])

  const fetchPendingTickets = useCallback(async () => {
    try {
      const response = await fetch(`${DAEMON_API_BASE}/api/pending-tickets`)
      if (!response.ok) {
        throw new Error(`Failed to fetch pending tickets: ${response.status}`)
      }
      const data = await response.json()
      setPendingTickets(data)
      setError(null)
    } catch (err) {
      console.warn('Failed to fetch pending tickets:', err)
      setError(err.message)
      setPendingTickets([])
    }
  }, [])

  const fetchCompletedTickets = useCallback(async () => {
    try {
      const response = await fetch(`${DAEMON_API_BASE}/api/completed-tickets`)
      if (!response.ok) {
        throw new Error(`Failed to fetch completed tickets: ${response.status}`)
      }
      const data = await response.json()
      setCompletedTickets(data)
      setError(null)
    } catch (err) {
      console.warn('Failed to fetch completed tickets:', err)
      setError(err.message)
      setCompletedTickets([])
    }
  }, [])

  const approveTicket = useCallback(async (ticketId) => {
    try {
      const response = await fetch(`${DAEMON_API_BASE}/api/approve/${ticketId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Failed to approve ticket: ${response.status}`)
      }
      const data = await response.json()
      // Refresh pending tickets after approval
      await fetchPendingTickets()
      return data
    } catch (err) {
      console.error('Failed to approve ticket:', err)
      throw err
    }
  }, [fetchPendingTickets])

  const updatePlaneTicket = useCallback(async (ticketId, summary) => {
    try {
      const response = await fetch(`${DAEMON_API_BASE}/api/update-plane/${ticketId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ summary }),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Failed to update Plane ticket: ${response.status}`)
      }
      // Refresh completed tickets after update
      await fetchCompletedTickets()
      return await response.json()
    } catch (err) {
      console.error('Failed to update Plane ticket:', err)
      throw err
    }
  }, [fetchCompletedTickets])

  const deleteTicket = useCallback(async (ticketId) => {
    try {
      const response = await fetch(`${DAEMON_API_BASE}/api/tickets/${ticketId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || `Failed to delete ticket: ${response.status}`)
      }
      // Refresh both queues after deletion
      await Promise.all([fetchPendingTickets(), fetchCompletedTickets()])
      return await response.json()
    } catch (err) {
      console.error('Failed to delete ticket:', err)
      throw err
    }
  }, [fetchPendingTickets, fetchCompletedTickets])

  // Initial fetch and polling setup
  useEffect(() => {
    const fetchAll = async () => {
      setIsLoading(true)
      const healthy = await fetchHealth()
      if (healthy) {
        await Promise.all([fetchPendingTickets(), fetchCompletedTickets()])
      }
      setIsLoading(false)
    }

    fetchAll()

    const interval = setInterval(fetchAll, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchHealth, fetchPendingTickets, fetchCompletedTickets])

  return {
    pendingTickets,
    completedTickets,
    isLoading,
    error,
    daemonHealthy,
    approveTicket,
    updatePlaneTicket,
    deleteTicket,
    refresh: async () => {
      await Promise.all([fetchPendingTickets(), fetchCompletedTickets()])
    },
  }
}
