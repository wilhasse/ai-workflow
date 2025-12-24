/**
 * WindowTabs - Horizontal tabs for tmux windows within a workspace
 */
function WindowTabs({
  windows,
  activeWindowIndex,
  onSelectWindow,
  onRefresh,
  loading,
}) {
  if (loading) {
    return (
      <div className="window-tabs-loading">
        <span>Loading windows...</span>
      </div>
    )
  }

  if (!windows || windows.length === 0) {
    return (
      <div className="window-tabs-empty">
        <span>Session not active</span>
        <button type="button" onClick={onRefresh} className="refresh-btn">
          Refresh
        </button>
      </div>
    )
  }

  return (
    <div className="window-tabs">
      {windows.map((window) => (
        <button
          key={window.index}
          type="button"
          className={`window-tab ${activeWindowIndex === window.index ? 'active' : ''}`}
          onClick={() => onSelectWindow(window.index)}
          title={`Window ${window.index}: ${window.name}`}
        >
          <span className="window-index">{window.index}</span>
          <span className="window-name">{window.name}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onRefresh}
        className="window-tab refresh-tab"
        title="Refresh window list"
      >
        ↻
      </button>
    </div>
  )
}

export default WindowTabs
