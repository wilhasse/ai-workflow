function formatTime(d) {
  if (!d) return ''
  return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function MessageBubble({ message }) {
  const role = message.msg_role || message.msg_type || 'unknown'
  const isUser = role === 'user'
  const text = message.content_text

  if (!text) return null

  return (
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      <div className="message-role">{role}</div>
      <div className="message-content">{text}</div>
      <div className="message-time">{formatTime(message.ts)}</div>
    </div>
  )
}
