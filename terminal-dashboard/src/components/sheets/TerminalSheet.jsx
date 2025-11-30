import { useState, useRef, useCallback } from 'react'
import BottomSheet from './BottomSheet'

function SwipeableItem({ children, onDelete }) {
  const [translateX, setTranslateX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const touchState = useRef({ startX: 0 })

  const handleTouchStart = useCallback((e) => {
    e.stopPropagation()
    touchState.current = { startX: e.touches[0].clientX }
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (!isDragging) return
    const deltaX = e.touches[0].clientX - touchState.current.startX
    if (deltaX < 0) {
      setTranslateX(Math.max(deltaX, -100))
    }
  }, [isDragging])

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false)
    const shouldShowDelete = translateX < -50
    setTranslateX(shouldShowDelete ? -80 : 0)
  }, [translateX])

  const handleDelete = useCallback(() => {
    setTranslateX(0)
    onDelete()
  }, [onDelete])

  return (
    <div className="swipeable-item-wrapper">
      <div
        className="swipeable-item"
        style={{
          transform: `translateX(${translateX}px)`,
          transition: isDragging ? 'none' : 'transform 0.2s ease',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
      <button
        type="button"
        className="swipe-delete-action"
        onClick={handleDelete}
        style={{
          opacity: translateX < 0 ? 1 : 0,
        }}
      >
        Delete
      </button>
    </div>
  )
}

function TerminalSheet({
  isOpen,
  onClose,
  terminals,
  activeTerminalId,
  onSelectTerminal,
  onDeleteTerminal,
  onAddTerminal,
  projectName,
}) {
  const [formName, setFormName] = useState('')
  const [formNotes, setFormNotes] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const name = formName.trim()
    if (!name) return
    onAddTerminal({ name, notes: formNotes.trim() })
    setFormName('')
    setFormNotes('')
  }

  const handleSelect = (terminalId) => {
    onSelectTerminal(terminalId)
    onClose()
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={projectName ? `${projectName} - Terminals` : 'Terminals'}
      height="half"
    >
      <div className="sheet-list">
        {terminals.length === 0 ? (
          <div className="sheet-empty">
            <p>No terminals yet. Add one below.</p>
          </div>
        ) : (
          terminals.map((terminal) => {
            const isActive = terminal.id === activeTerminalId

            return (
              <SwipeableItem
                key={terminal.id}
                onDelete={() => onDeleteTerminal(terminal.id)}
              >
                <div
                  className={`sheet-list-item ${isActive ? 'active' : ''}`}
                  onClick={() => handleSelect(terminal.id)}
                >
                  <div className="sheet-list-item-content">
                    <strong>{terminal.name}</strong>
                    {terminal.notes && (
                      <span className="sheet-list-item-meta">{terminal.notes}</span>
                    )}
                  </div>
                  {isActive && <span className="active-indicator">✓</span>}
                </div>
              </SwipeableItem>
            )
          })
        )}
      </div>

      <form className="sheet-form" onSubmit={handleSubmit}>
        <h3>Add Terminal</h3>
        <input
          type="text"
          placeholder="Terminal name"
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Notes (optional)"
          value={formNotes}
          onChange={(e) => setFormNotes(e.target.value)}
        />
        <button type="submit" className="primary">
          Add Terminal
        </button>
      </form>
    </BottomSheet>
  )
}

export default TerminalSheet
