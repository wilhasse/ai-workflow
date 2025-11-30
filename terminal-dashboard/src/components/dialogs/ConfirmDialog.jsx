function ConfirmDialog({ isOpen, title, message, onConfirm, onCancel }) {
  if (!isOpen) {
    return null
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="dialog-title">{title}</h3>}
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" className="dialog-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dialog-btn primary" onClick={onConfirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
