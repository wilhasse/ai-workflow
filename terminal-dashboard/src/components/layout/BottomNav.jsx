function BottomNav({ activeSheet, onSheetChange, isRecording, isPending, planePendingCount }) {
  const items = [
    {
      id: 'terminals',
      icon: '▣',
      label: 'Terminals',
    },
    {
      id: 'projects',
      icon: '📁',
      label: 'Projects',
    },
    {
      id: 'plane',
      icon: '⚡',
      label: 'Plane',
      badge: planePendingCount > 0 ? planePendingCount : null,
    },
    {
      id: 'voice',
      icon: isRecording ? '⏹️' : isPending ? '⏳' : '🎙️',
      label: 'Voice',
      className: isRecording ? 'recording' : isPending ? 'pending' : '',
    },
    {
      id: 'settings',
      icon: '⚙️',
      label: 'More',
    },
  ]

  return (
    <nav className="bottom-nav">
      {items.map((item) => {
        const isActive = activeSheet === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav-item ${isActive ? 'active' : ''} ${item.className || ''}`}
            onClick={() => onSheetChange(isActive ? null : item.id)}
            aria-label={item.label}
          >
            <span className="nav-icon">
              {item.icon}
              {item.badge && <span className="nav-badge">{item.badge}</span>}
            </span>
            <span className="nav-label">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

export default BottomNav
