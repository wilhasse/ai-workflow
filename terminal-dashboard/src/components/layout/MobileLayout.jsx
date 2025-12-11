import BottomNav from './BottomNav'

function MobileHeader({ projectName }) {
  return (
    <header className="mobile-header">
      <h1>AI Workflow</h1>
      {projectName && (
        <span className="current-project-badge">{projectName}</span>
      )}
    </header>
  )
}

function MobileLayout({
  children,
  activeSheet,
  onSheetChange,
  projectName,
  isRecording,
  isPending,
  planePendingCount,
}) {
  return (
    <div className="mobile-layout">
      <MobileHeader projectName={projectName} />
      <main className="mobile-main">
        {children}
      </main>
      <BottomNav
        activeSheet={activeSheet}
        onSheetChange={onSheetChange}
        isRecording={isRecording}
        isPending={isPending}
        planePendingCount={planePendingCount}
      />
    </div>
  )
}

export default MobileLayout
