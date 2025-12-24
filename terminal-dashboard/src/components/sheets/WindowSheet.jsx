import BottomSheet from './BottomSheet'

/**
 * WindowSheet - Mobile bottom sheet for tmux window selection
 */
function WindowSheet({
  isOpen,
  onClose,
  windows,
  activeWindowIndex,
  onSelectWindow,
  workspaceName,
  loading,
  onRefresh,
}) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Windows" height="half">
      {workspaceName && (
        <div className="sheet-subtitle">
          <span>{workspaceName}</span>
        </div>
      )}

      {loading ? (
        <div className="sheet-loading">
          <p>Loading windows...</p>
        </div>
      ) : windows.length === 0 ? (
        <div className="sheet-empty">
          <p>Session not active</p>
          <p className="sheet-hint">
            Start the session in your x2go terminal first.
          </p>
          <button type="button" className="secondary" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      ) : (
        <div className="window-list">
          {windows.map((window) => (
            <button
              key={window.index}
              type="button"
              className={`window-list-item ${activeWindowIndex === window.index ? 'active' : ''}`}
              onClick={() => {
                onSelectWindow(window.index)
                onClose()
              }}
            >
              <span className="window-item-index">{window.index}</span>
              <span className="window-item-name">{window.name}</span>
              {window.active && <span className="window-item-active">*</span>}
            </button>
          ))}
        </div>
      )}

      <div className="sheet-footer">
        <button type="button" className="secondary" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </BottomSheet>
  )
}

export default WindowSheet
