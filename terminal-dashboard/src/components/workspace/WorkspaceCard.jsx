/**
 * WorkspaceCard - A styled button representing a workspace/tmux session
 * Similar to the GTK panel workspace-switcher buttons
 */
function WorkspaceCard({ workspace, isSelected, onSelect }) {
  const statusColor = workspace.active
    ? 'var(--color-success, #22c55e)'
    : 'var(--color-text-tertiary, #6b7280)'

  return (
    <button
      type="button"
      className={`workspace-card ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(workspace)}
      style={{ '--workspace-color': workspace.color || '#6366f1' }}
    >
      <div className="workspace-status" style={{ color: statusColor }}>
        {workspace.active ? '●' : '○'}
      </div>
      <div className="workspace-content">
        <strong>{workspace.name}</strong>
        {workspace.description && (
          <small>{workspace.description}</small>
        )}
      </div>
    </button>
  )
}

export default WorkspaceCard
