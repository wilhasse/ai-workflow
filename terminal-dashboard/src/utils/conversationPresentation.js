const numericTimestamp = (value) => {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed < 1e12 ? parsed * 1000 : parsed
}

export const conversationTimestamp = (conversation) => {
  const numericCandidates = [
    conversation?.conversationAt,
    conversation?.conversation_at,
    conversation?.conversation_recency_at,
    conversation?.recencyAt,
    conversation?.recency_at,
    conversation?.updatedAt,
    conversation?.updated_at,
    conversation?.score,
  ]
  for (const candidate of numericCandidates) {
    const timestamp = numericTimestamp(candidate)
    if (timestamp) return timestamp
  }

  for (const candidate of [conversation?.started_at, conversation?.ts, conversation?.created_at]) {
    const timestamp = Date.parse(candidate || '')
    if (Number.isFinite(timestamp)) return timestamp
  }
  return 0
}

export const conversationTitle = (conversation) => String(
  conversation?.conversationTitle
  || conversation?.conversation_title
  || conversation?.name
  || conversation?.summary
  || conversation?.title
  || conversation?.display_text
  || conversation?.session_display
  || conversation?.preview
  || conversation?.firstPrompt
  || 'Untitled conversation',
).replace(/\s+/g, ' ').trim()

export const conversationFolder = (conversation) => {
  if (conversation?.folder) return String(conversation.folder)
  const cwd = String(conversation?.cwd || conversation?.project || '')
    .replace(/\/+$/, '')
  return cwd.split('/').filter(Boolean).at(-1) || cwd
}

export const compareConversationRecency = (left, right) => {
  const difference = conversationTimestamp(right) - conversationTimestamp(left)
  if (difference) return difference
  const leftId = String(left?.resumeId || left?.session_id || left?.id || '')
  const rightId = String(right?.resumeId || right?.session_id || right?.id || '')
  return leftId.localeCompare(rightId)
}

const startOfLocalDay = (timestamp) => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export const conversationDateLabel = (timestamp) => {
  if (!timestamp) return 'Unknown date'
  const today = startOfLocalDay(Date.now())
  const conversationDay = startOfLocalDay(timestamp)
  const dayDifference = Math.round((today - conversationDay) / 86400000)
  if (dayDifference === 0) return 'Today'
  if (dayDifference === 1) return 'Yesterday'
  return new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export const groupConversationsByDate = (conversations, { sort = true } = {}) => {
  const ordered = sort ? [...conversations].sort(compareConversationRecency) : conversations
  const groups = []
  for (const conversation of ordered) {
    const timestamp = conversationTimestamp(conversation)
    const key = timestamp ? new Date(timestamp).toLocaleDateString('en-CA') : 'unknown'
    const previous = groups.at(-1)
    if (previous?.key === key) {
      previous.conversations.push(conversation)
      continue
    }
    groups.push({
      key,
      label: conversationDateLabel(timestamp),
      conversations: [conversation],
    })
  }
  return groups
}

export const formatConversationDateTime = (conversation) => {
  const timestamp = conversationTimestamp(conversation)
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
