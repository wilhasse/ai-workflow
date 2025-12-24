import BottomSheet from './BottomSheet'
import WorkspaceCard from '../workspace/WorkspaceCard'

/**
 * WorkspaceSheet - Mobile bottom sheet for workspace selection
 * Read-only list of workspaces with active status
 */
function WorkspaceSheet({
  isOpen,
  onClose,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  loading,
  error,
  onRefresh,
}) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Workspaces" height="half">
      {loading ? (
        <div className="sheet-loading">
          <p>Loading workspaces...</p>
        </div>
      ) : error ? (
        <div className="sheet-error">
          <p>{error}</p>
          <button type="button" className="secondary" onClick={onRefresh}>
            Retry
          </button>
        </div>
      ) : (
        <div className="workspace-list">
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              isSelected={workspace.id === activeWorkspaceId}
              onSelect={() => {
                onSelectWorkspace(workspace.id)
                onClose()
              }}
            />
          ))}
          {workspaces.length === 0 && (
            <div className="sheet-empty">
              <p>No workspaces configured.</p>
              <p className="sheet-hint">
                Add workspaces via the GTK panel (wsp) on your x2go session.
              </p>
            </div>
          )}
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

export default WorkspaceSheet
