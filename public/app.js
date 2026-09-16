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
  stop: document.getElementById('stop'),
  like: document.getElementById('like'),
  dislike: document.getElementById('dislike'),
  unlike: document.getElementById('unlike'),
  session: document.getElementById('session'),
  brief: document.getElementById('brief'),
  plan: document.getElementById('plan'),
  clearPlan: document.getElementById('clearPlan'),
  codexStatus: document.getElementById('codexStatus'),
  codexPicks: document.getElementById('codexPicks'),
  prep: document.getElementById('prepStatus'),
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
  resolving: false,
  codexPicks: [],
  attempts: 0, // 解析尝试总次数，用于验证没有快速重试
  sessionId: null,
  adjustments: {},
  playId: null,
  feedback: new Map(), // trackId -> 'like' | 'dislike'
  awaitingRefill: false, // 队列播完、正在等后台补充的下一批
}

// 播放意图的代次号：每一次新的播放/暂停/切歌意图都自增，
// 异步结果返回时如果代次已经变了，就说明它是过期结果，必须丢弃。
let playToken = 0
// 用户当前是否希望出声。加载中点暂停后，晚到的解析结果不能把播放重新拉起来。
let userWantsPlayback = false

/* ---------- 后台补歌编排（队列、补歌、意图、退避收敛在这里） ---------- */

function pendingCount() {
  return Math.max(0, state.queue.length - state.index - 1)
}

function getRefillContext() {
  return {
    sessionId: state.sessionId,
    playing: userWantsPlayback,
    stopped: state.stopped,
    pending: pendingCount(),
    brief: (el.brief && el.brief.value ? el.brief.value.trim() : '') || '继续按我的口味接着放',
  }
}

/** 新增队列要排除：当前曲、已排队曲、已失败曲。 */
function getRefillExclusion() {
  const ids = new Set()
  if (state.current) ids.add(Number(state.current.id))
  for (let i = state.index + 1; i < state.queue.length; i += 1) ids.add(Number(state.queue[i].id))
  for (const id of state.failedIds) ids.add(Number(id))
  return [...ids].filter((n) => Number.isFinite(n))
}

function setPrepStatus(text, cls = '') {
  if (!el.prep) return
  el.prep.textContent = text
  el.prep.className = 'status prep' + (cls ? ' ' + cls : '')
}

/** 只追加、不替换；去重掉已经在队列或已失败的曲目。 */
function appendPicks(picks) {
  const known = new Set(state.queue.map((t) => Number(t.id)))
  const added = []
  for (const p of picks) {
    const id = Number(p.id)
    if (!Number.isFinite(id) || known.has(id) || state.failedIds.has(id)) continue
    known.add(id)
    added.push({ ...p, type: p.type || 'track', auto: true })
  }
  if (added.length) {
    state.queue = state.queue.concat(added)
    renderTracks()
    updateControls()
    el.counter.textContent = `${state.index + 1} / ${state.queue.length} · ${state.sourceLabel}`
  }
  return added
}

const refillController = new RadioOrchestrator.RefillController({
  requestBatch: async ({ epoch, excludeIds, brief, sessionId }) => {
    const res = await fetch('/api/queue/refill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId || state.sessionId,
        epoch,
        excludeIds,
        count: refillController.config.batchSize,
        brief,
      }),
    })
    const data = await res.json().catch(() => ({}))
    return { ...data, ok: Boolean(res.ok && data.ok), status: res.status }
  },
  getContext: getRefillContext,
  getExclusion: getRefillExclusion,
  onStatus: setPrepStatus,
  onBatch: (picks, res) => {
    const added = appendPicks(picks)
    if (res.degraded) {
      setPrepStatus(`Codex 暂不可用，已用曲库候选降级续播 ${added.length} 首（不打断当前歌曲）。`, 'warn')
    } else {
      setPrepStatus(`已后台补充 ${added.length} 首（Codex 选歌），不打断当前歌曲。`, 'ok')
    }
    // 队列刚好播完时，这一批到达后就接着放，而不是停在末尾
    if (state.awaitingRefill && userWantsPlayback && !state.stopped) {
      state.awaitingRefill = false
      playIndex(state.index + 1)
    }
  },
})

/** 补歌参数来自本地设置，默认值见 server/db.js。 */
async function loadRefillSettings() {
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const s = data.settings || {}
    refillController.setConfig({
      threshold: s.refillThreshold,
      batchSize: s.refillBatchSize,
      backoffBaseMs: s.refillBackoffBaseMs,
      backoffMaxMs: s.refillBackoffMaxMs,
      maxAttempts: s.refillMaxAttempts,
    })
  } catch (_) {}
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
      loadedId: loadedSrcId(),
      paused: audio.paused,
      ended: audio.ended,
      stopped: state.stopped,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      consecutiveFailures: state.consecutiveFailures,
      failureCount: state.failureCount,
      resolveAttempts: state.attempts,
      resolving: state.resolving,
      userWantsPlayback,
      playToken,
      failedIds: [...state.failedIds],
      lastError: state.lastError,
      status: el.status.textContent,
      statusClass: el.status.className,
      codexPicks: state.codexPicks.map((p) => ({ id: p.id, name: p.name, reason: p.reason })),
      queueIds: state.queue.map((t) => t.id),
      codexStatus: el.codexStatus.textContent,
      codexStatusClass: el.codexStatus.className,
      sessionId: state.sessionId,
      adjustments: state.adjustments,
      playId: state.playId,
      feedback: Object.fromEntries(state.feedback),
      playButtonLabel: el.play.textContent,
      prepStatus: el.prep ? el.prep.textContent : '',
      awaitingRefill: state.awaitingRefill,
      pending: pendingCount(),
      refill: refillController.snapshot(),
      autoQueueIds: state.queue.filter((t) => t.auto).map((t) => t.id),
    }
  },
}

// 测试专用钩子：只用于构造可控队列/读取编排状态，不改变生产路径。
window.__radio.__test = {
  replaceQueue(tracks) {
    selectSource('test', '测试队列', tracks)
  },
  setConfig(cfg) {
    return refillController.setConfig(cfg)
  },
  config() {
    return { ...refillController.config }
  },
  refill() {
    return refillController.check({ force: true })
  },
  refillState() {
    return refillController.snapshot()
  },
  pending() {
    return pendingCount()
  },
  /** 加速跨批验证：把当前曲目拉到接近结尾，触发真实的 ended 事件。 */
  seekToEnd() {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return false
    audio.currentTime = Math.max(0, audio.duration - 0.35)
    return true
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
  // 切来源 = 新的编排意图：作废在途补歌结果，并停掉还在放的旧音频，避免“界面换了、声音没换”
  refillController.cancel('source_changed', { reset: true })
  playToken += 1
  userWantsPlayback = false
  state.resolving = false
  if (!audio.paused) audio.pause()
  state.awaitingRefill = false
  state.queue = tracks.filter((t) => t.id).map((t) => ({ ...t, type: t.type || 'track' }))
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
    const id = Number(row.dataset.id)
    row.classList.toggle('current', state.current && id === state.current.id)
    row.classList.toggle('failed', state.failedIds.has(id))
    row.classList.toggle('codex', state.codexPicks.some((p) => p.id === id))
    row.classList.toggle('liked', state.feedback.get(id) === 'like')
    row.classList.toggle('disliked', state.feedback.get(id) === 'dislike')
    row.classList.toggle('auto', Boolean(state.queue.find((t) => Number(t.id) === id && t.auto)))
  })
  updateFeedbackButtons()
}

function updateControls() {
  const has = state.queue.length > 0
  el.play.disabled = !has
  el.next.disabled = !has
  el.stop.disabled = !state.sessionId
  // 解析中也要显示“暂停”，否则用户没有入口取消正在进行的加载
  if (state.resolving || (state.started && !audio.paused)) el.play.textContent = '暂停'
  else el.play.textContent = state.sessionId ? '继续' : '开播'
}

/* ---------- 播放核心 ---------- */

async function resolveTrack(id, force = false) {
  state.attempts += 1
  const res = await fetch(`/api/resolve/${id}${force ? '?force=1' : ''}`)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, ...data }
}

async function playIndex(index, { userGesture = false } = {}) {
  if (index < 0 || index >= state.queue.length) {
    userWantsPlayback = false
    setStatus('没有更多可播放的歌曲。', 'warn')
    state.stopped = true
    updateControls()
    return
  }
  if (state.stopped && !userGesture) return
  if (userGesture) {
    state.stopped = false
    state.awaitingRefill = false
    state.consecutiveFailures = 0
    // 用户动作可以从「等待恢复」里把补歌重新拉起来
    refillController.resume()
  }

  const queued = state.queue[index]
  if (queued && queued.type && queued.type !== 'track') {
    // 统一编排接口为将来的播报留位；播报未实现，明确跳过而不是假装能播
    setStatus(`队列里的「${queued.type}」类型内容暂未实现，已跳过。`, 'warn')
    state.index = index
    return playIndex(index + 1, { userGesture: true })
  }

  // 切到新一首前先结束上一条播放记录，并确保有会话。
  // 否则直接点曲目切歌时 playId 没清空，notePlayStart 会跳过，拿不到新会话，
  // 服务端会话失效后补歌就会因此停住。
  closePlay('replaced')
  if (!state.sessionId) await ensureSession()

  // 取一个代次号；并发切歌时只有最后一次意图对应的结果允许生效
  const token = ++playToken
  userWantsPlayback = true
  state.resolving = true

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
    if (token !== playToken) return
    state.resolving = false
    return handleTrackFailure(track, '解析请求失败：' + err.message, index)
  }

  // 解析期间用户又切了歌或点了暂停：丢弃过期结果，不碰播放器
  if (token !== playToken || !userWantsPlayback) {
    if (token === playToken) state.resolving = false
    return
  }
  state.resolving = false

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
    // play() 等待期间又发生了切歌/暂停，别继续播
    if (token !== playToken) audio.pause()
  } catch (err) {
    if (token !== playToken) return
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
  state.resolving = false
  closePlay('failed')
  state.failedIds.add(track.id)
  state.failureCount += 1
  state.lastError = { id: track.id, name: track.name, reason }
  state.consecutiveFailures += 1
  markCurrent()

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state.stopped = true
    userWantsPlayback = false
    // 连续失败时连后台补歌一起停下，避免一边失败一边继续消耗额度
    refillController.cancel('playback_failed', { reset: true })
    setStatus(
      `连续 ${state.consecutiveFailures} 首无法播放，已停止自动换歌。最后一次原因：${reason}。请检查登录状态或稍后再试。`,
      'bad',
    )
    updateControls()
    return
  }
  setStatus(`「${track.name}」失败：${reason} → ${RETRY_DELAY_MS / 1000}s 后自动换下一首`, 'warn')
  // 失败会让待播变少，顺便看看需不需要补歌
  refillController.check()
  const timerToken = playToken
  setTimeout(() => {
    // 退避期间用户可能已经手动选了别的歌或点了暂停：
    // 代次变了就说明这次自动换歌已经过期，不能再把用户选的歌切走。
    if (timerToken !== playToken) return
    if (!state.stopped && userWantsPlayback) playIndex(index + 1)
  }, RETRY_DELAY_MS)
}

function next({ userGesture = false } = {}) {
  if (!state.queue.length) return
  const nextIndex = state.index + 1
  if (nextIndex >= state.queue.length) {
    state.consecutiveFailures = 0
    state.stopped = false
    // 队列到头但补歌还在路上/还能重试：等这一批，而不是宣告“已到末尾”
    if (refillController.canWaitAtEnd()) {
      state.awaitingRefill = true
      setStatus('当前队列已播完，正在等后台补充的下一批…', 'warn')
      refillController.check({ force: true })
      updateControls()
      return
    }
    setStatus('当前队列已播完，且后台没有可补充的候选。', 'warn')
    state.stopped = true
    userWantsPlayback = false
    updateControls()
    return
  }
  state.consecutiveFailures = 0
  state.stopped = false
  state.awaitingRefill = false
  closePlay('skipped')
  playIndex(nextIndex, { userGesture })
}

/* ---------- 事件 ---------- */

audio.addEventListener('playing', () => {
  state.started = true
  state.consecutiveFailures = 0
  state.stopped = false
  setStatus(`播放中：${state.current.name} — ${state.current.artists}`, 'playing')
  updateControls()
  notePlayStart()
  // 正在出声才考虑提前准备下一批；暂停时不主动发新的生成请求
  refillController.resume()
  refillController.check()
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
  closePlay('ended')
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
  // 用户已经暂停/停止：这不算“播放中断”，不要记账也不要自动换歌
  if (!userWantsPlayback) {
    setStatus('已暂停；播放地址刷新后仍未取到可用地址。', 'warn')
    return
  }
  handleTrackFailure(state.current, '播放地址失效且刷新后仍失败', state.index)
})

async function refreshCurrent() {
  const track = state.current
  const token = playToken
  state.attempts += 1
  try {
    const r = await resolveTrack(track.id, true)
    if (token !== playToken) return
    if (!r.ok || !r.playable) throw new Error(r.message || '刷新未取得可用地址')
    audio.src = r.audioUrl + '?t=' + Date.now()
    // 刷新地址是为了能继续听，不是为了自动出声：
    // 如果用户已经暂停，只把地址换好，等他本人点播放。
    if (!userWantsPlayback) {
      setStatus('播放地址已刷新，等待继续播放。', 'warn')
      updateControls()
      return
    }
    await audio.play()
  } catch (err) {
    if (token !== playToken) return
    if (!userWantsPlayback) {
      setStatus('已暂停；刷新播放地址失败：' + err.message, 'warn')
      return
    }
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

function pausePlayback() {
  // 代次自增 = 作废所有在途解析请求；这是“加载中暂停”不被覆盖的关键
  playToken += 1
  userWantsPlayback = false
  state.resolving = false
  if (!audio.paused) audio.pause()
  setStatus('已暂停。')
  // 后台补歌不因暂停而中断，但结果只会追加进队列，不会自动出声
  if (refillController.isPreparing()) {
    setPrepStatus('已暂停；后台仍在准备下一批，迟到结果不会自动出声。', 'warn')
  }
  updateControls()
}

/** 当前 <audio> 里实际装着哪首歌（切歌解析期间它可能还是上一首）。 */
function loadedSrcId() {
  const src = audio.currentSrc || audio.src || ''
  const m = src.match(/\/api\/audio\/(\d+)/)
  return m ? Number(m[1]) : null
}

el.play.onclick = async () => {
  // 正在解析（加载中）也允许暂停：这里必须取消在途请求，否则结果回来后会把播放重新拉起
  if (state.resolving || (state.started && !audio.paused)) {
    pausePlayback()
    return
  }
  // 只有“已经装进播放器的就是列表当前这首”时才能直接续播。
  // 切歌加载中暂停过的话，播放器里还是上一首，直接续播会变成界面显示新歌、实际放旧歌。
  const loaded = loadedSrcId()
  const currentId = state.current ? state.current.id : null
  if (loaded && loaded === currentId && audio.currentTime > 0) {
    playToken += 1
    userWantsPlayback = true
    try {
      await audio.play()
    } catch (err) {
      setStatus('浏览器拒绝播放：' + err.message, 'bad')
    }
    updateControls()
    return
  }
  state.stopped = false
  state.consecutiveFailures = 0
  await ensureSession()
  playIndex(state.index >= 0 ? state.index : 0, { userGesture: true })
}

el.next.onclick = () => next({ userGesture: true })
el.reload.onclick = loadLibrary

/* ---------- Codex 选歌 ---------- */

function setCodexStatus(text, cls = '') {
  el.codexStatus.textContent = text
  el.codexStatus.className = 'status' + (cls ? ' ' + cls : '')
}

function renderCodexPicks(picks) {
  el.codexPicks.innerHTML = ''
  picks.forEach((p, i) => {
    const row = document.createElement('div')
    row.className = 'pick'
    row.innerHTML =
      `<span class="pidx">${i + 1}</span>` +
      `<span class="pbody"><span class="pname">${escapeHtml(p.name)} — ${escapeHtml(p.artists || '')}</span>` +
      `<span class="preason">${escapeHtml(p.reason || '')}</span></span>`
    row.onclick = () => {
      const qi = state.queue.findIndex((t) => t.id === p.id)
      if (qi >= 0) playIndex(qi, { userGesture: true })
    }
    el.codexPicks.appendChild(row)
  })
}

/** 把 Codex 选出的歌接到当前播放之后；不打断正在响的那首。 */
function applyCodexQueue(data) {
  // 用户主动点了「让 Codex 选歌」= 新的编排意图：旧的自动补歌任务作废
  refillController.cancel('plan_applied', { reset: true })
  state.awaitingRefill = false
  const picks = data.picks.map((p) => ({ ...p, fromCodex: true, type: p.type || 'track' }))
  const current = state.current
  state.queue = current
    ? [{ ...current, type: current.type || 'track' }, ...picks]
    : picks
  state.index = current ? 0 : -1
  state.codexPicks = picks
  state.sourceLabel = 'Codex 选歌'
  state.stopped = false
  state.consecutiveFailures = 0
  renderTracks()
  renderCodexPicks(picks)
  updateControls()
  el.counter.textContent = `${current ? 1 : 0} / ${state.queue.length} · ${state.sourceLabel}`
  refillController.check()
}

async function requestPlan() {
  el.plan.disabled = true
  setCodexStatus('Codex 正在选歌…（可能要十几秒）')
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: el.brief.value.trim(), count: 5 }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      const err = new Error(data.message || `HTTP ${res.status}`)
      err.code = data.code || 'error'
      throw err
    }
    applyCodexQueue(data)
    const secs = data.meta && data.meta.durationMs ? (data.meta.durationMs / 1000).toFixed(1) : '?'
    setCodexStatus(
      `Codex 选出 ${data.picks.length} 首，已接在当前播放之后（用时 ${secs}s）。点下面任意一首可直接播放。`,
      'ok',
    )
  } catch (err) {
    // 失败时什么都不改：原队列继续播，只是把原因说清楚
    setCodexStatus(
      `Codex 选歌失败（${err.code}）：${err.message}。继续使用原队列，播放不受影响。`,
      'bad',
    )
  } finally {
    el.plan.disabled = false
  }
}

el.plan.onclick = requestPlan
el.clearPlan.onclick = () => {
  state.codexPicks = []
  renderCodexPicks([])
  setCodexStatus('已清除 Codex 队列标记（当前队列未改动）。')
  markCurrent()
}

/* ---------- 收听会话、播放记录与喜好反馈 ---------- */

/** 开播前建立会话；已有会话则直接复用（刷新页面不会新建会话）。 */
async function ensureSession() {
  if (state.sessionId) return state.sessionId
  try {
    const res = await fetch('/api/session/start', { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      state.sessionId = data.session.id
      state.adjustments = data.session.adjustments || {}
      renderSession()
      updateControls()
      refillController.sessionReady()
    }
  } catch (_) {}
  return state.sessionId
}

async function stopSession() {
  playToken += 1
  userWantsPlayback = false
  state.resolving = false
  state.awaitingRefill = false
  // 停止 = 作废旧意图：在途补歌结果作废，也不会落到下一次会话
  refillController.cancel('stopped', { reset: true })
  if (!audio.paused) audio.pause()
  await closePlay('stopped')
  try {
    await fetch('/api/session/stop', { method: 'POST' })
  } catch (_) {}
  state.sessionId = null
  state.adjustments = {}
  setStatus('已停止收听。下次开播会建立新的收听会话。')
  setPrepStatus('已停止；后台补歌已取消。', '')
  renderSession()
  updateControls()
}

async function closePlay(outcome) {
  if (!state.playId) return
  const playId = state.playId
  state.playId = null
  try {
    await fetch('/api/plays/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playId, outcome }),
    })
  } catch (_) {}
}

async function notePlayStart() {
  if (state.playId || !state.current) return
  try {
    const res = await fetch('/api/plays/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackId: state.current.id,
        trackName: state.current.name,
        artists: state.current.artists,
      }),
    })
    const data = await res.json()
    if (data.ok) {
      state.playId = data.playId
      state.sessionId = data.session.id
      renderSession()
      updateControls()
      // 会话建立后再触发一次：有些入口（点曲目直接播放）先出声、后拿到会话
      refillController.sessionReady()
    }
  } catch (_) {}
}

function renderSession() {
  if (!state.sessionId) {
    el.session.textContent = '未开播'
    return
  }
  const adj = Object.entries(state.adjustments || {})
  el.session.textContent =
    `收听会话 ${state.sessionId}` +
    (adj.length ? '｜本次调整：' + adj.map(([k, v]) => `${k}=${v}`).join('、') : '')
}

/** 刷新页面时只重新连上服务端已有的会话，不建立新会话、不自动出声。 */
async function reattachSession() {
  try {
    const res = await fetch('/api/session')
    const data = await res.json()
    if (data.ok && data.session) {
      state.sessionId = data.session.id
      state.adjustments = data.session.adjustments || {}
      setStatus('已连上正在进行的收听会话，点“继续”接着听。')
    }  } catch (_) {}
  renderSession()
  updateControls()
}

async function loadFeedback() {
  try {
    const res = await fetch('/api/feedback')
    const data = await res.json()
    if (data.ok) {
      state.feedback = new Map(data.active.map((f) => [Number(f.track_id), f.sentiment]))
      markCurrent()
    }
  } catch (_) {}
}

function updateFeedbackButtons() {
  const id = state.current ? state.current.id : null
  const sentiment = id ? state.feedback.get(id) : null
  el.like.classList.toggle('active', sentiment === 'like')
  el.dislike.classList.toggle('active', sentiment === 'dislike')
  el.unlike.disabled = !sentiment
}

async function saveFeedback(sentiment) {
  if (!state.current) return
  const t = state.current
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackId: t.id,
        trackName: t.name,
        artists: t.artists,
        sentiment,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`)
    state.feedback.set(t.id, sentiment)
    markCurrent()
    setStatus(
      sentiment === 'like' ? `已记住：喜欢「${t.name}」` : `已记住：不喜欢「${t.name}」`,
      'ok',
    )
  } catch (err) {
    setStatus('反馈保存失败：' + err.message, 'bad')
  }
}

el.like.onclick = () => saveFeedback('like')
el.dislike.onclick = () => saveFeedback('dislike')
el.unlike.onclick = async () => {
  if (!state.current) return
  const t = state.current
  try {
    const res = await fetch('/api/feedback/' + t.id, { method: 'DELETE' })
    const data = await res.json()
    if (data.ok) {
      state.feedback.delete(t.id)
      markCurrent()
      setStatus(`已撤销对「${t.name}」的反馈`, 'ok')
    }
  } catch (err) {
    setStatus('撤销反馈失败：' + err.message, 'bad')
  }
}
el.stop.onclick = stopSession

loadLibrary()
loadFeedback()
loadRefillSettings()
reattachSession()
updateControls()
