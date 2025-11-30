import BottomSheet from './BottomSheet'

const VOICE_SERVICES = {
  LOCAL: 'local',
  DEEPGRAM: 'deepgram',
}

function VoiceSheet({
  isOpen,
  onClose,
  isSecureContext,
  voiceService,
  onVoiceServiceChange,
  voiceLanguage,
  onVoiceLanguageChange,
  voiceTranscript,
  voiceStatus,
  voiceError,
  voiceRecording,
  voicePending,
  hasDeepgramKey,
  hasTerminal,
  onStartRecording,
  onStopRecording,
  onFileUpload,
  onCopyTranscript,
  onSendToTerminal,
  onClearTranscript,
}) {
  const handleMicToggle = () => {
    if (voicePending) return
    if (voiceRecording) {
      onStopRecording()
    } else {
      onStartRecording()
    }
  }

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      onFileUpload(file)
      e.target.value = ''
    }
  }

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Voice Input" height="full">
      <div className="voice-sheet-content">
        <div className="voice-status-bar">
          <span className={`voice-status-indicator ${voiceRecording ? 'recording' : voicePending ? 'pending' : ''}`}>
            {voiceStatus}
          </span>
        </div>

        {!isSecureContext && (
          <p className="voice-warning">
            Microphone recording requires HTTPS (or localhost). You can still upload audio files.
          </p>
        )}

        <div className="voice-record-section">
          <button
            type="button"
            className={`voice-record-btn ${voiceRecording ? 'recording' : ''} ${voicePending ? 'pending' : ''}`}
            onClick={handleMicToggle}
            disabled={!isSecureContext || voicePending}
          >
            <span className="voice-record-icon">
              {voicePending ? '⏳' : voiceRecording ? '⏹️' : '🎙️'}
            </span>
            <span className="voice-record-label">
              {voicePending ? 'Processing...' : voiceRecording ? 'Tap to stop' : 'Tap to record'}
            </span>
          </button>
        </div>

        <div className="voice-settings">
          <label className="voice-setting">
            <span>Service</span>
            <select
              value={voiceService}
              onChange={(e) => onVoiceServiceChange(e.target.value)}
            >
              <option value={VOICE_SERVICES.DEEPGRAM}>Deepgram (cloud)</option>
              <option value={VOICE_SERVICES.LOCAL}>Local Whisper</option>
            </select>
          </label>

          <label className="voice-setting">
            <span>Language</span>
            <select
              value={voiceLanguage}
              onChange={(e) => onVoiceLanguageChange(e.target.value)}
            >
              <option value="pt-BR">Português (BR)</option>
              <option value="pt-PT">Português (PT)</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
        </div>

        {voiceService === VOICE_SERVICES.DEEPGRAM && !hasDeepgramKey && (
          <p className="voice-warning">
            Deepgram API key not configured. Add VITE_DEEPGRAM_API_KEY to .env file.
          </p>
        )}

        <label className="voice-upload-btn">
          <input
            type="file"
            accept="audio/*"
            onChange={handleFileChange}
          />
          <span>📁 Upload audio file</span>
        </label>

        <div className="voice-transcript-section">
          <label>Transcript</label>
          <textarea
            className="voice-transcript"
            placeholder="Transcript will appear here..."
            value={voiceTranscript}
            readOnly
            rows={4}
          />
        </div>

        {voiceError && <p className="voice-error">{voiceError}</p>}

        <div className="voice-actions">
          <button
            type="button"
            className="secondary"
            onClick={onCopyTranscript}
            disabled={!voiceTranscript}
          >
            Copy
          </button>
          <button
            type="button"
            className="primary"
            onClick={onSendToTerminal}
            disabled={!voiceTranscript || !hasTerminal || voicePending}
          >
            Send to terminal
          </button>
          <button
            type="button"
            className="secondary"
            onClick={onClearTranscript}
            disabled={!voiceTranscript && !voiceError}
          >
            Clear
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

export default VoiceSheet
