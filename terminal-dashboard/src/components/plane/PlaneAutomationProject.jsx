import { useState } from 'react'
import { usePlaneTickets } from '../../hooks/usePlaneTickets'
import './PlaneAutomation.css'

const PlaneAutomationProject = ({ onApproveTicket, onUpdatePlane }) => {
  const {
    pendingTickets,
    completedTickets,
    isLoading,
    error,
    daemonHealthy,
    approveTicket,
    updatePlaneTicket,
    deleteTicket,
  } = usePlaneTickets()

  const [editingSummary, setEditingSummary] = useState(null)
  const [editedText, setEditedText] = useState('')
  const [processingTicket, setProcessingTicket] = useState(null)

  const handleApprove = async (ticket) => {
    setProcessingTicket(ticket.id)
    try {
      const result = await approveTicket(ticket.id)
      // Call parent handler to create terminal
      if (onApproveTicket) {
        onApproveTicket(ticket, result)
      }
    } catch (err) {
      alert(`Failed to approve ticket: ${err.message}`)
    } finally {
      setProcessingTicket(null)
    }
  }

  const handleUpdatePlane = async (ticket) => {
    const summary = editingSummary === ticket.id ? editedText : ticket.summary
    setProcessingTicket(ticket.id)
    try {
      await updatePlaneTicket(ticket.id, summary)
      setEditingSummary(null)
      setEditedText('')
      if (onUpdatePlane) {
        onUpdatePlane(ticket)
      }
    } catch (err) {
      alert(`Failed to update Plane: ${err.message}`)
    } finally {
      setProcessingTicket(null)
    }
  }

  const handleDelete = async (ticketId) => {
    if (!confirm(`Are you sure you want to remove ticket ${ticketId} from the queue?`)) {
      return
    }
    setProcessingTicket(ticketId)
    try {
      await deleteTicket(ticketId)
    } catch (err) {
      alert(`Failed to delete ticket: ${err.message}`)
    } finally {
      setProcessingTicket(null)
    }
  }

  const startEditSummary = (ticket) => {
    setEditingSummary(ticket.id)
    setEditedText(ticket.summary || '')
  }

  const cancelEditSummary = () => {
    setEditingSummary(null)
    setEditedText('')
  }

  const getTriggerIcon = (triggerType) => {
    switch (triggerType) {
      case 'new_ticket':
        return '🆕'
      case 'status_change':
        return '🔄'
      case 'comment_added':
        return '💬'
      default:
        return '📋'
    }
  }

  const getTriggerLabel = (triggerType) => {
    switch (triggerType) {
      case 'new_ticket':
        return 'New ticket'
      case 'status_change':
        return 'Status changed'
      case 'comment_added':
        return 'Comment added'
      default:
        return 'Triggered'
    }
  }

  if (!daemonHealthy && !isLoading) {
    return (
      <div className="plane-automation-project">
        <div className="plane-header">
          <h3>⚡ Plane Automation</h3>
          <span className="daemon-status status-offline">Daemon Offline</span>
        </div>
        <div className="plane-error">
          <p>⚠️ Cannot connect to Plane orchestrator daemon</p>
          <p className="error-details">Make sure the daemon is running on port 5002</p>
        </div>
      </div>
    )
  }

  return (
    <div className="plane-automation-project">
      <div className="plane-header">
        <h3>⚡ Plane Automation</h3>
        <div className="plane-stats">
          {daemonHealthy && <span className="daemon-status status-online">● Online</span>}
          {pendingTickets.length > 0 && (
            <span className="ticket-count pending">{pendingTickets.length} pending</span>
          )}
          {completedTickets.length > 0 && (
            <span className="ticket-count completed">{completedTickets.length} completed</span>
          )}
        </div>
      </div>

      {error && (
        <div className="plane-error">
          <p>⚠️ {error}</p>
        </div>
      )}

      {isLoading && pendingTickets.length === 0 && completedTickets.length === 0 && (
        <div className="plane-loading">
          <p>Loading tickets...</p>
        </div>
      )}

      {/* Pending Tickets Section */}
      {pendingTickets.length > 0 && (
        <div className="plane-section">
          <h4 className="section-title">Pending Approval</h4>
          <div className="ticket-list">
            {pendingTickets.map((ticket) => (
              <div key={ticket.id} className="ticket-card pending-ticket">
                <div className="ticket-header">
                  <span className="ticket-id">{ticket.id}</span>
                  <span className="trigger-badge">
                    {getTriggerIcon(ticket.trigger_type)} {getTriggerLabel(ticket.trigger_type)}
                  </span>
                </div>
                <h5 className="ticket-title">{ticket.title}</h5>
                <div
                  className="ticket-description"
                  dangerouslySetInnerHTML={{ __html: ticket.description }}
                />
                <div className="ticket-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => handleApprove(ticket)}
                    disabled={processingTicket === ticket.id}
                  >
                    {processingTicket === ticket.id ? 'Approving...' : 'Approve & Start Claude'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleDelete(ticket.id)}
                    disabled={processingTicket === ticket.id}
                  >
                    Skip
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed Tickets Section */}
      {completedTickets.length > 0 && (
        <div className="plane-section">
          <h4 className="section-title">Ready to Update Plane</h4>
          <div className="ticket-list">
            {completedTickets.map((ticket) => (
              <div key={ticket.id} className="ticket-card completed-ticket">
                <div className="ticket-header">
                  <span className="ticket-id">✓ {ticket.id}</span>
                  <span className="completion-time">
                    Completed {new Date(ticket.completed_at).toLocaleTimeString()}
                  </span>
                </div>
                <h5 className="ticket-title">{ticket.title}</h5>

                {editingSummary === ticket.id ? (
                  <div className="summary-editor">
                    <label htmlFor={`summary-${ticket.id}`}>Summary:</label>
                    <textarea
                      id={`summary-${ticket.id}`}
                      className="summary-textarea"
                      value={editedText}
                      onChange={(e) => setEditedText(e.target.value)}
                      rows={4}
                      placeholder="Describe what was accomplished..."
                    />
                    <div className="editor-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() => handleUpdatePlane(ticket)}
                        disabled={!editedText.trim() || processingTicket === ticket.id}
                      >
                        {processingTicket === ticket.id ? 'Updating...' : 'Save & Update Plane'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={cancelEditSummary}
                        disabled={processingTicket === ticket.id}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="summary-display">
                    <p className="summary-text">{ticket.summary}</p>
                    <div className="ticket-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() => handleUpdatePlane(ticket)}
                        disabled={processingTicket === ticket.id}
                      >
                        {processingTicket === ticket.id ? 'Updating...' : 'Approve & Update Plane'}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => startEditSummary(ticket)}
                        disabled={processingTicket === ticket.id}
                      >
                        Edit Summary
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => handleDelete(ticket.id)}
                        disabled={processingTicket === ticket.id}
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && pendingTickets.length === 0 && completedTickets.length === 0 && (
        <div className="plane-empty">
          <p>No tickets in queue</p>
          <p className="empty-details">Pending tickets will appear here when triggered in Plane</p>
        </div>
      )}
    </div>
  )
}

export default PlaneAutomationProject
