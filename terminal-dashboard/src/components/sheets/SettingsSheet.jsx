import BottomSheet from './BottomSheet'

const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 22]

function SettingsSheet({
  isOpen,
  onClose,
  // Auth props
  authStatus,
  currentUser,
  authMode,
  authForm,
  authError,
  authBusy,
  isSyncingProjects,
  syncError,
  onAuthFormChange,
  onAuthModeToggle,
  onAuthSubmit,
  onLogout,
  onRetrySync,
  // Settings props
  terminalFontSize,
  onFontSizeChange,
  projectViewMode,
  onProjectViewModeChange,
}) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Settings" height="full">
      <div className="settings-sheet-content">
        {/* Auth Section */}
        <section className="settings-section">
          <h3>Account</h3>
          {authStatus === 'checking' ? (
            <p className="auth-message">Validating session…</p>
          ) : currentUser ? (
            <div className="auth-logged-in">
              <div className="auth-user-info">
                <span className="auth-label">Signed in as</span>
                <strong>{currentUser.username}</strong>
              </div>
              <div className="auth-sync-status">
                {isSyncingProjects ? (
                  <span className="sync-indicator syncing">Syncing…</span>
                ) : syncError ? (
                  <button
                    type="button"
                    className="sync-indicator error"
                    onClick={onRetrySync}
                  >
                    Sync failed — retry
                  </button>
                ) : (
                  <span className="sync-indicator ok">Projects synced</span>
                )}
              </div>
              <button type="button" className="secondary logout-btn" onClick={onLogout}>
                Logout
              </button>
            </div>
          ) : (
            <form className="auth-form-mobile" onSubmit={onAuthSubmit}>
              <input
                type="text"
                placeholder="Username"
                autoComplete="username"
                value={authForm.username}
                onChange={(e) => onAuthFormChange('username', e.target.value)}
                disabled={authBusy}
                required
              />
              <input
                type="password"
                placeholder="Password"
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                value={authForm.password}
                onChange={(e) => onAuthFormChange('password', e.target.value)}
                disabled={authBusy}
                required
              />
              {authError && <p className="auth-error">{authError}</p>}
              <button type="submit" className="primary" disabled={authBusy}>
                {authMode === 'register' ? 'Create account' : 'Sign in'}
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={onAuthModeToggle}
                disabled={authBusy}
              >
                {authMode === 'register'
                  ? 'Have an account? Sign in'
                  : 'Need an account? Register'}
              </button>
            </form>
          )}
        </section>

        {/* Display Settings */}
        <section className="settings-section">
          <h3>Display</h3>
          <label className="settings-row">
            <span>Terminal Font Size</span>
            <select
              value={terminalFontSize}
              onChange={(e) => onFontSizeChange(Number(e.target.value))}
            >
              {FONT_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row">
            <span>Project View (Desktop)</span>
            <select
              value={projectViewMode}
              onChange={(e) => onProjectViewModeChange(e.target.value)}
            >
              <option value="dropdown">Dropdown</option>
              <option value="tabs">Tabs</option>
            </select>
          </label>
        </section>
      </div>
    </BottomSheet>
  )
}

export default SettingsSheet
