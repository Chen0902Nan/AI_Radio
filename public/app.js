/* 最小播放器：点击播放才出声；单曲失败自动换歌；连续失败停止快速重试。 */

const audio = document.getElementById('audio')
const el = {
  account: document.getElementById('account'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  album: document.getElementById('album'),
  elapsed: document.getElementById('elapsed'),
  duration: document.getElementById('duration'),
  fill: document.getElementById('fill'),
  play: document.getElementById('play'),
  next: document.getElementById('next'),
  counter: document.getElementById('counter'),
  status: document.getElementById('status'),
  likedCount: document.getElementById('likedCount'),
  likedItem: document.getElementById('likedItem'),
  playlists: document.getElementById('playlists'),
  tracks: document.getElementById('tracks'),
  reload: document.getElementById('reload'),
}

const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_DELAY_MS = 1200

const state = {
  queue: [],
  sourceLabel: '红心歌曲',
  index: -1,
  current: null,
  started: false,
  refreshedCurrent: false,
  consecutiveFailures: 0,
  failureCount: 0,
  lastError: null,
  failedIds: new Set(),
  stopped: false,
  attempts: 0, // 解析尝试总次数，用于验证没有快速重试
}

// 给自动化验证读取的只读快照。
window.__radio = {
  get state() {
    return {
      currentId: state.current ? state.current.id : null,
      currentTitle: state.current ? state.current.name : null,
      index: state.index,
      queueLength: state.queue.length,
      started: state.started,
      audioSrc: audio.currentSrc || audio.src || '',
      paused: audio.paused,
      ended: audio.ended,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      consecutiveFailures: state.consecutiveFailures,
      failureCount: state.failureCount,
      resolveAttempts: state.attempts,
      failedIds: [...state.failedIds],
      lastError: state.lastError,
      status: el.status.textContent,
      statusClass: el.status.className,
    }
  },
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function setStatus(text, cls = '') {
  el.status.textContent = text
  el.status.className = 'status' + (cls ? ' ' + cls : '')
}

function fmtMs(ms) {
  return fmt(ms / 1000)
}

/* ---------- 资料读取 ---------- */

async function loadLibrary() {
  setStatus('正在读取账号音乐资料…')
  el.likedCount.textContent = '…'
  try {
    const res = await fetch('/api/library')
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
    renderAccount(data.account)
    el.likedCount.textContent = data.liked.count
    el.likedItem.dataset.tracks = JSON.stringify(data.liked.tracks)
    renderPlaylists(data.playlists)
    selectSource('liked', '红心歌曲', data.liked.tracks)
    setStatus(`已读取红心歌曲 ${data.liked.count} 首，收藏/自建歌单 ${data.playlists.total} 个。`, 'ok')
  } catch (err) {
    el.likedCount.textContent = '—'
    renderAccount(null)
    setStatus('读取音乐资料失败：' + err.message + '（请先到 /login 扫码）', 'bad')
  }
}

function renderAccount(account) {
  if (account) {
    el.account.textContent = `${account.nickname} · uid ${account.userId}`
    el.account.className = 'account ok'
  } else {
    el.account.innerHTML = '未登录 · <a href="/login" style="color:inherit">去扫码登录</a>'
    el.account.className = 'account bad'
  }
}

function renderPlaylists(playlists) {
  el.playlists.innerHTML = ''
  const all = [
    ...playlists.created.map((p) => ({ ...p, kind: '自建' })),
    ...playlists.collected.map((p) => ({ ...p, kind: '收藏' })),
  ]
  for (const pl of all) {
    const b = document.createElement('button')
    b.className = 'list-item'
    b.innerHTML = `<span class="li-name" title="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</span><span class="li-count">${pl.kind} ${pl.trackCount}</span>`
    b.onclick = async () => {
      document.querySelectorAll('.list-item').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      setStatus(`正在读取歌单「${pl.name}」…`)
      try {
        const r = await fetch('/api/playlist/' + pl.id)
        const d = await r.json()
        if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`)
        selectSource(String(pl.id), `歌单：${pl.name}`, d.tracks)
        setStatus(`歌单「${pl.name}」读取到 ${d.returned}/${d.trackCount} 首（${d.via}）。`, 'ok')
      } catch (err) {
        setStatus('读取歌单失败：' + err.message, 'bad')
      }
    }
    el.playlists.appendChild(b)
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function selectSource(key, label, tracks) {
  state.queue = tracks.filter((t) => t.id)
  state.sourceLabel = label
  state.index = -1
  state.current = null
  state.stopped = false
  state.consecutiveFailures = 0
  renderTracks()
  updateControls()
  el.counter.textContent = state.queue.length ? `0 / ${state.queue.length} · ${label}` : ''
}

function renderTracks() {
  el.tracks.innerHTML = ''
  state.queue.forEach((t, i) => {
    const row = document.createElement('div')
    row.className = 'track'
    row.dataset.id = t.id
    row.innerHTML = `<span class="idx">${i + 1}</span><span class="tn" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span><span class="td">${fmtMs(t.durationMs)}</span>`
    row.title = `${t.name} — ${t.artists}${t.album ? ' · ' + t.album : ''}`
    row.onclick = () => playIndex(i, { userGesture: true })
    el.tracks.appendChild(row)
  })
  markCurrent()
}

function markCurrent() {
  document.querySelectorAll('.track').forEach((row) => {
    row.classList.toggle('current', state.current && Number(row.dataset.id) === state.current.id)
    row.classList.toggle('failed', state.failedIds.has(Number(row.dataset.id)))
  })
}

function updateControls() {
  const has = state.queue.length > 0
  el.play.disabled = !has
  el.next.disabled = !has
  el.play.textContent = state.started && !audio.paused ? '暂停' : '播放'
}

/* ---------- 播放核心 ---------- */

async function resolveTrack(id, force = false) {
  state.attempts += 1
  const res = await fetch(`/api/resolve/${id}${force ? '?force=1' : ''}`)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, ...data }
}

async function playIndex(index, { userGesture = false, isAuto = false } = {}) {
  if (index < 0 || index >= state.queue.length) {
    setStatus('没有更多可播放的歌曲。', 'warn')
    state.stopped = true
    updateControls()
    return
  }
  if (state.stopped && !userGesture) return
  if (userGesture) {
    state.stopped = false
    state.consecutiveFailures = 0
  }

  const track = state.queue[index]
  state.index = index
  state.current = track
  state.refreshedCurrent = false
  markCurrent()
  showTrack(track)
  el.counter.textContent = `${index + 1} / ${state.queue.length} · ${state.sourceLabel}`
  setStatus(`解析音源：${track.name}…`)
  updateControls()

  let r
  try {
    r = await resolveTrack(track.id)
  } catch (err) {
    return handleTrackFailure(track, '解析请求失败：' + err.message, index)
  }

  if (!r.ok || !r.playable) {
    const reason =
      r.code === 'trial_only'
        ? '仅试听片段权限，按规格跳过'
        : r.code === 'unplayable'
          ? '账号当前无播放权限'
          : r.message || `音源不可用 (HTTP ${r.status})`
    return handleTrackFailure(track, reason, index)
  }

  audio.src = r.audioUrl + '?t=' + Date.now()
  try {
    await audio.play()
  } catch (err) {
    // 浏览器拦截自动播放或加载失败：按单曲失败处理，交给统一换歌逻辑。
    handleTrackFailure(track, '浏览器拒绝播放：' + err.message, index)
  }
}

function showTrack(t) {
  el.title.textContent = t.name
  el.artist.textContent = t.artists || '—'
  el.album.textContent = t.album || ''
  el.duration.textContent = fmtMs(t.durationMs)
}

function handleTrackFailure(track, reason, index) {
  // 切歌时旧音频还在响；解析失败必须停掉它，否则会出现“界面报失败但旧歌还在放”。
  audio.pause()
  state.failedIds.add(track.id)
  state.failureCount += 1
  state.lastError = { id: track.id, name: track.name, reason }
  state.consecutiveFailures += 1
  markCurrent()

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state.stopped = true
    setStatus(
      `连续 ${state.consecutiveFailures} 首无法播放，已停止自动换歌。最后一次原因：${reason}。请检查登录状态或稍后再试。`,
      'bad',
    )
    updateControls()
    return
  }
  setStatus(`「${track.name}」失败：${reason} → ${RETRY_DELAY_MS / 1000}s 后自动换下一首`, 'warn')
  setTimeout(() => {
    if (!state.stopped) playIndex(index + 1, { isAuto: true })
  }, RETRY_DELAY_MS)
}

function next({ userGesture = false } = {}) {
  if (!state.queue.length) return
  const nextIndex = state.index + 1
  if (nextIndex >= state.queue.length) {
    setStatus('已到列表末尾。', 'warn')
    state.stopped = true
    updateControls()
    return
  }
  state.consecutiveFailures = 0
  state.stopped = false
  playIndex(nextIndex, { userGesture })
}

/* ---------- 事件 ---------- */

audio.addEventListener('playing', () => {
  state.started = true
  state.consecutiveFailures = 0
  state.stopped = false
  setStatus(`播放中：${state.current.name} — ${state.current.artists}`, 'playing')
  updateControls()
})

audio.addEventListener('ended', () => {
  const ev = {
    type: 'ended',
    id: state.current && state.current.id,
    at: Date.now(),
    currentTime: audio.currentTime,
    duration: audio.duration,
  }
  window.__radio.events = (window.__radio.events || []).concat([ev])
  setStatus('播放结束，自动下一首。', 'ok')
  next()
})

audio.addEventListener('error', () => {
  if (!state.current) return
  const err = audio.error
  const msg = err ? `媒体错误 code=${err.code}` : '媒体错误'
  if (!state.refreshedCurrent) {
    state.refreshedCurrent = true
    setStatus(`播放中断（${msg}），尝试刷新播放地址…`, 'warn')
    refreshCurrent()
    return
  }
  handleTrackFailure(state.current, '播放地址失效且刷新后仍失败', state.index)
})

async function refreshCurrent() {
  const track = state.current
  state.attempts += 1
  try {
    const r = await resolveTrack(track.id, true)
    if (!r.ok || !r.playable) throw new Error(r.message || '刷新未取得可用地址')
    audio.src = r.audioUrl + '?t=' + Date.now()
    await audio.play()
  } catch (err) {
    handleTrackFailure(track, '刷新地址失败：' + err.message, state.index)
  }
}

audio.addEventListener('timeupdate', () => {
  el.elapsed.textContent = fmt(audio.currentTime)
  const d = audio.duration
  if (Number.isFinite(d) && d > 0) {
    el.duration.textContent = fmt(d)
    el.fill.style.width = (audio.currentTime / d) * 100 + '%'
  }
})

audio.addEventListener('pause', updateControls)

el.play.onclick = async () => {
  if (!state.started || audio.paused) {
    if (audio.src && audio.currentTime > 0 && audio.paused) {
      await audio.play()
      return
    }
    state.stopped = false
    state.consecutiveFailures = 0
    const from = state.index >= 0 ? state.index : 0
    playIndex(from, { userGesture: true })
  } else {
    audio.pause()
  }
}

el.next.onclick = () => next({ userGesture: true })
el.reload.onclick = loadLibrary

loadLibrary()
updateControls()
