const $ = id => document.getElementById(id)
const PAGE_SIZE = 50
const MESSAGE_PAGE_SIZE = 100
const MAX_EXPORT_BYTES = 1024 * 1024
const state = { signedIn: false, authVersion: 0, list: [], branches: new Map(), offset: 0, selected: null, messageOffset: 0, listVersion: 0, detailVersion: 0, messageVersion: 0, listBusy: false, messagesBusy: false, exportBusy: false }
let searchTimer

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function date(value, short = false) {
  if (!value) return 'Date unavailable'
  const normalized = /^\d{4}-\d\d-\d\d \d\d:/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat(undefined, short
    ? { month: 'short', day: 'numeric', year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed)
}

function title(row) {
  return (row.title || row.display_text || row.session_display || row.content_text || row.session_id || 'Untitled conversation').split('\n').find(line => line.trim())?.slice(0, 220) || 'Untitled conversation'
}

function errorAt(id, message = '') {
  $(id).textContent = message
  $(id).hidden = !message
}

function showLogin(message = '') {
  state.signedIn = false
  state.authVersion++
  state.listVersion++
  state.detailVersion++
  state.messageVersion++
  state.selected = null
  state.list = []
  state.branches.clear()
  $('conversation-list').replaceChildren()
  $('messages').replaceChildren()
  $('summary-text').textContent = ''
  $('conversation-title').textContent = ''
  $('conversation-project').textContent = ''
  $('archive').hidden = true
  $('login-screen').hidden = false
  $('boot-status').hidden = true
  $('password').value = ''
  errorAt('login-error', message)
}

async function request(path, options = {}, responseType = 'json') {
  const authVersion = state.authVersion
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal })
    if (res.ok && responseType === 'markdown') {
      if (!res.headers.get('content-type')?.startsWith('text/markdown')) throw new Error('The archive returned an invalid handoff. Please try again.')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let bytes = 0
      let text = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return text + decoder.decode()
          bytes += value.byteLength
          if (bytes > MAX_EXPORT_BYTES) {
            await reader.cancel()
            throw new Error('This handoff exceeds the download size limit.')
          }
          text += decoder.decode(value, { stream: true })
        }
      } finally { reader.releaseLock() }
    }
    const payload = await res.json()
    if (!res.ok || !payload.ok) {
      if (res.status === 401 && state.signedIn && authVersion === state.authVersion) showLogin('Your session has expired. Sign in to continue.')
      throw new Error(payload.error || `Request failed (${res.status})`)
    }
    return payload.data
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('This request took too long. Please try again.')
    if (err instanceof TypeError) throw new Error('Cannot reach the archive. Check your connection and try again.')
    throw err
  } finally { clearTimeout(timeout) }
}

const api = path => request(`/api/agent-history${path}`)
const post = (path, body = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function updateUrl(push = false) {
  const url = new URL(location.href)
  for (const [key, value] of Object.entries({ q: $('search').value.trim(), source: $('source').value, host: $('host').value, session: state.selected?.session_id, vm_id: state.selected?.vm_id })) {
    if (value) url.searchParams.set(key, value)
    else url.searchParams.delete(key)
  }
  history[push ? 'pushState' : 'replaceState']({}, '', url)
}

function readUrl() {
  const params = new URLSearchParams(location.search)
  $('search').value = (params.get('q') ?? '').slice(0, 200)
  $('source').value = ['codex', 'claude'].includes(params.get('source')) ? params.get('source') : ''
  const host = params.get('host') ?? ''
  if (host && ![...$('host').options].some(option => option.value === host)) $('host').add(new Option(host, host))
  $('host').value = host
  const session_id = params.get('session')
  const vm_id = params.get('vm_id')
  return session_id && vm_id ? { session_id, vm_id } : null
}

function showListState(heading, detail = '', retry = false) {
  const box = element('div', 'list-state')
  box.append(element('strong', '', heading), element('span', '', detail))
  if (retry) {
    const button = element('button', 'button secondary', 'Try again')
    button.type = 'button'
    button.addEventListener('click', () => loadList())
    box.append(element('br'), button)
  }
  $('conversation-list').replaceChildren(box)
}

const sessionKey = row => JSON.stringify([row.session_id, row.vm_id])

function conversationRow(row, { child = false, search = false, ancestors = new Set() } = {}) {
  const key = sessionKey(row)
  const branch = state.branches.get(key)
  const group = element('div', `conversation-group${child ? ' conversation-child' : ' conversation-root'}`)
  group.dataset.sessionId = row.session_id
  group.dataset.vmId = row.vm_id
  const selected = state.selected?.session_id === row.session_id && state.selected?.vm_id === row.vm_id
  const card = element('button', `conversation-card${selected ? ' selected' : ''}`)
  card.type = 'button'
  card.dataset.listControl = `select:${search ? JSON.stringify([row.session_id, row.vm_id, row.message_id, row.ts]) : key}`
  card.setAttribute('aria-pressed', String(selected))
  const top = element('span', 'card-top')
  top.append(element('span', 'card-source', child ? 'Helper' : row.source || 'Conversation'), element('span', '', date(row.last_activity || row.ts || row.started_at, true)))
  const label = child ? row.agent_nickname || row.agent_path || row.session_id : title(row)
  card.append(top, element('span', 'card-title', label))
  const project = row.project?.split('/').filter(Boolean).pop()
  card.append(element('span', 'card-project', [project, row.vm_id].filter(Boolean).join(' · ')))
  if (search && row.content_text) card.append(element('p', 'card-snippet', row.content_text.slice(0, 300)))
  card.addEventListener('click', () => openConversation(row, true))
  group.append(card)
  if (!search && row.child_count > 0 && !ancestors.has(key)) {
    const disclosure = element('button', 'helper-toggle', `${branch?.expanded ? '▾' : '▸'} ${row.child_count} ${Number(row.child_count) === 1 ? 'helper' : 'helpers'}`)
    disclosure.type = 'button'
    disclosure.dataset.listControl = `toggle:${key}`
    disclosure.setAttribute('aria-label', `${row.child_count} ${Number(row.child_count) === 1 ? 'helper' : 'helpers'}`)
    disclosure.setAttribute('aria-expanded', String(Boolean(branch?.expanded)))
    disclosure.addEventListener('click', () => toggleChildren(row))
    group.append(disclosure)
    if (branch?.expanded) {
      const children = element('div', 'conversation-children')
      children.setAttribute('aria-label', `Helpers for ${label}`)
      const path = new Set(ancestors).add(key)
      for (const helper of branch.rows) children.append(conversationRow(helper, { child: true, ancestors: path }))
      if (branch.busy) {
        const loading = element('p', 'helper-status', 'Loading helpers…')
        loading.setAttribute('role', 'status')
        children.append(loading)
      } else if (branch.error) {
        const error = element('p', 'helper-status helper-error', branch.error)
        error.setAttribute('role', 'alert')
        const retry = element('button', 'helper-more', 'Try again')
        retry.type = 'button'
        retry.dataset.listControl = `more:${key}`
        retry.addEventListener('click', () => loadChildren(row))
        children.append(error, retry)
      } else if (branch.loaded && !branch.rows.length) {
        children.append(element('p', 'helper-status', 'No helpers match these filters.'))
      } else if (branch.more) {
        const more = element('button', 'helper-more', 'Load more helpers')
        more.type = 'button'
        more.dataset.listControl = `more:${key}`
        more.addEventListener('click', () => loadChildren(row))
        children.append(more)
      }
      group.append(children)
    }
  }
  return group
}

function paintList() {
  const focusedControl = document.activeElement?.dataset.listControl
  const fragment = document.createDocumentFragment()
  const search = Boolean($('search').value.trim())
  for (const row of state.list) fragment.append(conversationRow(row, { search }))
  $('conversation-list').replaceChildren(fragment)
  if (focusedControl) {
    const control = [...$('conversation-list').querySelectorAll('[data-list-control]')].find(node => node.dataset.listControl === focusedControl)
    control?.focus({ preventScroll: true })
  }
  if (!state.list.length) showListState(search ? 'No matching messages' : 'No conversations here yet', search ? 'Try another word, or change the source and host filters.' : 'Try another filter or check the cloud sync status below.')
}

function toggleChildren(row) {
  const key = sessionKey(row)
  let branch = state.branches.get(key)
  if (!branch) {
    branch = { expanded: false, rows: [], loaded: false, more: false, busy: false, error: '' }
    state.branches.set(key, branch)
  }
  branch.expanded = !branch.expanded
  if (branch.expanded && !branch.loaded && !branch.busy) loadChildren(row)
  else paintList()
}

async function loadChildren(row) {
  const key = sessionKey(row)
  const branch = state.branches.get(key)
  if (!state.signedIn || !branch || branch.busy) return
  const version = state.listVersion
  const current = () => state.signedIn && version === state.listVersion && state.branches.get(key) === branch
  branch.busy = true
  branch.error = ''
  paintList()
  const params = new URLSearchParams({ vm_id: row.vm_id, limit: PAGE_SIZE, offset: branch.rows.length })
  if ($('source').value) params.set('source', $('source').value)
  try {
    const rows = await api(`/sessions/${encodeURIComponent(row.session_id)}/children?${params}`)
    if (!current()) return
    branch.rows.push(...rows)
    branch.loaded = true
    branch.more = rows.length === PAGE_SIZE
  } catch (err) {
    if (current()) branch.error = err.message
  } finally {
    if (current()) {
      branch.busy = false
      paintList()
    }
  }
}

async function loadList(reset = false) {
  if (!state.signedIn) return
  if (reset) state.offset = 0
  const version = ++state.listVersion
  state.branches.clear()
  state.listBusy = true
  $('list-prev').disabled = true
  $('list-next').disabled = true
  $('refresh').disabled = true
  showListState('Loading conversations…')
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.offset })
  if ($('source').value) params.set('source', $('source').value)
  if ($('host').value) params.set('vm_id', $('host').value)
  const q = $('search').value.trim()
  if (q) params.set('q', q)
  else params.set('grouped', '1')
  $('list-caption').textContent = q ? 'Matching messages' : 'Recent conversations'
  $('list-count').textContent = ''
  updateUrl()
  try {
    const rows = await api(`/${q ? 'search' : 'sessions'}?${params}`)
    if (version !== state.listVersion || !state.signedIn) return
    state.list = rows
    paintList()
    $('list-count').textContent = String(rows.length)
    $('list-page').textContent = `Page ${Math.floor(state.offset / PAGE_SIZE) + 1}`
    $('list-prev').disabled = state.offset === 0
    $('list-next').disabled = rows.length < PAGE_SIZE
  } catch (err) {
    if (version === state.listVersion && state.signedIn) showListState('Couldn’t load conversations', err.message, true)
  } finally {
    if (version === state.listVersion) { state.listBusy = false; $('refresh').disabled = false }
  }
}

function closeConversation(push = true) {
  state.selected = null
  state.detailVersion++
  state.messageVersion++
  $('archive').dataset.view = 'list'
  $('reader-empty').hidden = false
  $('conversation').hidden = true
  $('messages').replaceChildren()
  updateUrl(push)
  paintList()
}

async function openConversation(row, push = false) {
  if (!row.session_id || !row.vm_id || !state.signedIn) return
  const version = ++state.detailVersion
  state.messageVersion++
  state.selected = { session_id: row.session_id, vm_id: row.vm_id }
  state.messageOffset = 0
  $('archive').dataset.view = 'conversation'
  $('reader-empty').hidden = true
  $('conversation').hidden = false
  $('conversation-title').textContent = title(row)
  $('conversation-source').textContent = row.source || 'Conversation'
  $('conversation-host').textContent = row.vm_id
  $('conversation-project').textContent = row.project || ''
  $('conversation-date').textContent = 'Loading conversation…'
  $('messages').replaceChildren(element('p', 'muted small', 'Loading messages…'))
  $('summary-panel').hidden = true
  $('summary-panel').open = false
  $('summary-text').textContent = ''
  $('message-count').textContent = ''
  $('load-more').hidden = true
  errorAt('message-error')
  const base = `/sessions/${encodeURIComponent(row.session_id)}`
  const params = new URLSearchParams({ vm_id: row.vm_id })
  $('handoff').href = `/api/agent-history${base}/handoff?${params}&format=raw`
  $('handoff').download = `conversation-${row.session_id}.md`
  updateUrl(push)
  paintList()
  $('reader').scrollTop = 0
  const metadata = api(`${base}?${params}`).then(session => {
    if (version !== state.detailVersion || !state.signedIn) return
    $('conversation-title').textContent = title(session)
    $('conversation-source').textContent = session.source || row.source || 'Conversation'
    $('conversation-project').textContent = session.project || ''
    $('conversation-date').textContent = `Started ${date(session.started_at)}`
    if (session.summary) {
      $('summary-panel').hidden = false
      $('summary-text').textContent = session.summary
    }
  }).catch(err => {
    if (version === state.detailVersion && state.signedIn) {
      $('conversation-date').textContent = ''
      errorAt('message-error', `Conversation details: ${err.message}`)
    }
  })
  await Promise.allSettled([metadata, loadMessages(true)])
}

async function loadMessages(reset = false) {
  if (!state.selected || !state.signedIn) return
  const version = ++state.messageVersion
  const detailVersion = state.detailVersion
  if (reset) state.messageOffset = 0
  state.messagesBusy = true
  $('load-more').disabled = true
  $('load-more').textContent = 'Loading…'
  if (reset) $('messages').replaceChildren(element('p', 'muted small', 'Loading messages…'))
  errorAt('message-error')
  const params = new URLSearchParams({ vm_id: state.selected.vm_id, limit: MESSAGE_PAGE_SIZE, offset: state.messageOffset, dialog: $('show-tools').checked ? '0' : '1' })
  try {
    const rows = await api(`/sessions/${encodeURIComponent(state.selected.session_id)}/messages?${params}`)
    if (version !== state.messageVersion || detailVersion !== state.detailVersion || !state.signedIn) return
    if (reset) $('messages').replaceChildren()
    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      const role = row.msg_role || row.role || row.msg_type || 'event'
      const article = element('article', 'message')
      article.dataset.role = role
      const top = element('div', 'message-top')
      const avatar = element('span', 'message-avatar', role === 'user' ? 'Y' : role === 'assistant' ? 'A' : '↳')
      avatar.setAttribute('aria-hidden', 'true')
      top.append(avatar, element('span', 'role', role === 'user' ? 'You' : role), element('time', 'message-time', date(row.ts || row.timestamp)))
      let content = row.content_text
      if (!content && $('show-tools').checked && row.content_json) content = typeof row.content_json === 'string' ? row.content_json : JSON.stringify(row.content_json, null, 2)
      article.append(top, element('p', 'message-content', content || '(No text content)'))
      fragment.append(article)
    }
    $('messages').append(fragment)
    state.messageOffset += rows.length
    $('message-caption').textContent = $('show-tools').checked ? 'Messages, tools & events' : 'Conversation messages'
    $('message-count').textContent = `${state.messageOffset.toLocaleString()} messages shown`
    $('load-more').hidden = rows.length < MESSAGE_PAGE_SIZE
    if (!state.messageOffset) $('messages').append(element('p', 'muted small', 'No messages in this view. Try enabling tools and events.'))
  } catch (err) {
    if (version === state.messageVersion && detailVersion === state.detailVersion && state.signedIn) {
      errorAt('message-error', err.message)
      if (reset) $('messages').replaceChildren()
      $('load-more').hidden = false
      $('load-more').textContent = 'Retry loading messages'
    }
  } finally {
    if (version === state.messageVersion) {
      state.messagesBusy = false
      $('load-more').disabled = false
      if ($('load-more').textContent === 'Loading…') $('load-more').textContent = 'Load more messages'
    }
  }
}

async function loadSyncStatus() {
  try {
    const rows = await api('/sync/status')
    if (!state.signedIn) return
    const current = $('host').value
    const hosts = [...new Set(rows.map(row => row.vm_id).filter(Boolean))].sort()
    if (current && !hosts.includes(current)) hosts.push(current)
    $('host').replaceChildren(new Option('All hosts', ''), ...hosts.map(host => new Option(host, host)))
    $('host').value = current
    $('sync-status').replaceChildren(...rows.map(row => {
      const line = element('div', 'sync-row')
      line.append(element('span', '', `${row.vm_id} · ${row.source}`), element('span', '', date(row.last_sync)))
      return line
    }))
    if (!rows.length) $('sync-status').textContent = 'No host metadata has been copied yet.'
  } catch (err) {
    if (state.signedIn) $('sync-status').textContent = err.message
  }
}

async function showArchive(user) {
  state.signedIn = true
  state.authVersion++
  $('signed-user').textContent = user.username
  $('login-screen').hidden = true
  $('archive').hidden = false
  $('boot-status').hidden = true
  $('password').value = ''
  errorAt('global-error')
  const selected = readUrl()
  state.selected = selected
  if (selected) openConversation(selected)
  else closeConversation(false)
  await Promise.allSettled([loadList(true), loadSyncStatus()])
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  $('login-submit').disabled = true
  $('login-submit').textContent = 'Signing in…'
  errorAt('login-error')
  try { await showArchive(await post('/auth/login', { username: $('username').value.trim(), password: $('password').value })) }
  catch (err) { errorAt('login-error', err.message) }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = 'Sign in →' }
})
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true
  try { await post('/auth/logout'); showLogin(); $('username').focus() }
  catch (err) { errorAt('global-error', `Couldn’t sign out: ${err.message}`) }
  finally { $('logout').disabled = false }
})
$('handoff').addEventListener('click', async event => {
  event.preventDefault()
  if (state.exportBusy || !state.signedIn || !state.selected) return
  state.exportBusy = true
  const authVersion = state.authVersion
  const detailVersion = state.detailVersion
  const filename = $('handoff').download
  $('handoff').setAttribute('aria-disabled', 'true')
  errorAt('global-error')
  try {
    const markdown = await request($('handoff').href, {}, 'markdown')
    if (!state.signedIn || authVersion !== state.authVersion || detailVersion !== state.detailVersion) return
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown; charset=utf-8' }))
    const link = element('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err) {
    if (state.signedIn && authVersion === state.authVersion) errorAt('global-error', `Couldn’t export handoff: ${err.message}`)
  } finally {
    state.exportBusy = false
    $('handoff').removeAttribute('aria-disabled')
  }
})
$('search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); loadList(true) })
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadList(true), 450) })
$('source').addEventListener('change', () => loadList(true))
$('host').addEventListener('change', () => loadList(true))
$('refresh').addEventListener('click', () => { loadList(true); loadSyncStatus() })
$('list-prev').addEventListener('click', () => { if (!state.listBusy) { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadList() } })
$('list-next').addEventListener('click', () => { if (!state.listBusy) { state.offset += PAGE_SIZE; loadList() } })
$('back').addEventListener('click', () => closeConversation())
$('show-tools').addEventListener('change', () => loadMessages(true))
$('load-more').addEventListener('click', () => { if (!state.messagesBusy) loadMessages() })
window.addEventListener('popstate', () => {
  if (!state.signedIn) return
  const selected = readUrl()
  if (selected) openConversation(selected)
  else closeConversation(false)
  loadList(true)
})
window.addEventListener('pageshow', event => {
  if (event.persisted) request('/auth/session').then(showArchive).catch(() => showLogin())
})
request('/auth/session').then(showArchive).catch(err => showLogin(err.message === 'Please sign in' ? '' : err.message))
