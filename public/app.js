/* 最小播放器：点击播放才出声；歌曲与 DJ 串场共用同一个 <audio>；单曲失败自动换歌；连续失败停止快速重试。
 *
 * 节目契约（public/program-contract.js）与串场控制器（public/segue-controller.js）提供
 * 身份、校验与决定逻辑；本文件只做执行：分派媒体、上报事件、执行决定、渲染界面。
 */
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
  djEnabled: document.getElementById('djEnabled'),
  djInterval: document.getElementById('djInterval'),
  djStatus: document.getElementById('djStatus'),
  segueInfo: document.getElementById('segueInfo'),
  segueTarget: document.getElementById('segueTarget'),
  segueScript: document.getElementById('segueScript'),
  segueSources: document.getElementById('segueSources'),
  previewVoice: document.getElementById('previewVoice'),
  previewBtn: document.getElementById('previewBtn'),
  previewSave: document.getElementById('previewSave'),
}

const contract = window.RadioProgramContract
const MAX_CONSECUTIVE_FAILURES = 3
const RETRY_DELAY_MS = 1200
const SEGUE_POLL_MS = 2000
const SEGUE_POLL_DEADLINE_MS = 170000 // 略大于服务端 150s 总截止

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
  // —— DJ 串场 ——
  currentKind: 'track', // 'track' | 'segue'
  segue: null, // 正在播放/刚决定的串场成品 {segueId, script, audio}
  segueStarted: false, // 本次串场是否实际出过声
  previewing: false, // 主动试听中：事件不进控制器、不记历史
}

// 播放意图的代次号：每一次新的播放/暂停/切歌意图都自增，
// 异步结果返回时如果代次已经变了，就说明它是过期结果，必须丢弃。
let playToken = 0
// 用户当前是否希望出声。加载中点暂停后，晚到的解析结果不能把播放重新拉起来。
let userWantsPlayback = false

// 播放实例登记：暂停恢复复用，重新开始同一条目则新建（契约第 1 节）。
const playTracker = contract.createPlayInstanceTracker()
// 试听代次号：再次点试听、开播或停止收听都会作废在途结果，避免迟到响应替换媒体。
let previewSeq = 0
// 媒体里实际装的是哪次播放实例：同一首歌重播时 trackId 相同，
// 只有播放实例能区分「旧音频的遗留事件」和「这一次播放的事件」。
let mediaPlayInstance = null
// 服务端只返回配置是否齐全及操作提示，不下发密钥。
let djVoiceConfig = null

/* ---------- DJ 串场（任务 04 控制器 + 05 接口） ---------- */

function setDjStatus(text, cls = '') {
  el.djStatus.textContent = text
  el.djStatus.className = 'status prep' + (cls ? ' ' + cls : '')
}

/** 提交准备并轮询到终态；任何失败都返回可处理结果，不抛出。 */
async function prepareSegueRequest(req) {
  try {
    const res = await fetch('/api/dj/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      return { state: 'unavailable', code: data.code || 'error', message: data.message || `HTTP ${res.status}` }
    }
    let cur = data.job
    if (cur.state === 'unavailable' || cur.state === 'stale') {
      return { state: cur.state, segueId: cur.segueId, reason: cur.reason, code: cur.code, message: cur.message }
    }
    const deadline = Date.now() + SEGUE_POLL_DEADLINE_MS
    while (cur.state === 'preparing' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SEGUE_POLL_MS))
      const r2 = await fetch(`/api/dj/jobs/${cur.segueId}`)
      const d = await r2.json().catch(() => ({}))
      if (!r2.ok || !d.ok) break // 任务被清理：按失效处理
      cur = d.job
    }
    if (cur.state === 'ready') {
      return { state: 'ready', segueId: cur.segueId, script: cur.script, audio: cur.audio, deviations: cur.deviations }
    }
    return {
      state: cur.state === 'stale' ? 'stale' : 'unavailable',
      segueId: cur.segueId,
      reason: cur.reason,
      code: cur.code,
      message: cur.message,
    }
  } catch (err) {
    return { state: 'unavailable', code: 'network', message: String((err && err.message) || err) }
  }
}

const segueCtl = new RadioSegueController.SegueController({
  requestPrepare: prepareSegueRequest,
  onChange: () => renderDjStatus(),
  cancelPrepare: (segueId, reason) => {
    fetch(`/api/dj/jobs/${segueId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).catch(() => {})
  },
})

function segueEpoch() {
  return segueCtl.snapshot().epoch
}

/** 控制器事件后刷新 DJ 状态行（简短展示准备/就绪/冷却/略过原因）。 */
function renderDjStatus() {
  const s = segueCtl.snapshot()
  if (!s.djEnabled) {
    setDjStatus('DJ 已关闭，纯音乐模式。')
    return
  }
  if (djVoiceConfig && !djVoiceConfig.ready) {
    setDjStatus(`${djVoiceConfig.message} 当前继续纯音乐。`, 'warn')
    return
  }
  if (s.blockedReason) {
    setDjStatus(`${s.lastReason?.message || `语音配置不可用（${s.blockedReason}）`} 更新配置后恢复；当前继续纯音乐。`, 'warn')
    return
  }
  if (s.cooldownRemainingMs > 0) {
    setDjStatus(`语音服务冷却中（约 ${Math.ceil(s.cooldownRemainingMs / 1000)} 秒），继续播放音乐。`, 'warn')
    return
  }
  if (state.currentKind === 'segue') {
    setDjStatus('串场播出中。', 'ok')
    return
  }
  if (s.state === 'preparing') setDjStatus('后台准备串场（搜索资料 → 生成语音）…', 'ok')
  else if (s.state === 'ready') setDjStatus('串场已就绪，将在当前歌曲自然结束时播出。', 'ok')
  else if (s.stopped) setDjStatus('已停止收听。')
  else setDjStatus(`自然播完 ${s.naturalCount}/${s.djIntervalTracks} 首，到点播出一次串场。`)
}

function applyDjConfig({ voiceUpdated = false } = {}) {
  segueCtl.setConfig({
    djEnabled: Boolean(el.djEnabled.checked),
    djIntervalTracks: Number(el.djInterval.value) || 4,
    voiceConfigUpdated: voiceUpdated,
  })
  renderDjStatus()
}

async function saveDjSetting(key, value) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`)
    djVoiceConfig = data.djVoice || null
    renderDjStatus()
    return true
  } catch (err) {
    setDjStatus('设置保存失败：' + err.message, 'bad')
    return false
  }
}

async function loadDjSettings() {
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const s = data.settings || {}
    djVoiceConfig = data.djVoice || null
    const savedVoice = djVoiceConfig?.voiceReferenceId || s.djVoiceReferenceId
    if (savedVoice && !el.previewVoice.value.trim()) el.previewVoice.value = savedVoice
    el.djEnabled.checked = s.djEnabled !== 'false'
    if (['3', '4', '5'].includes(String(s.djIntervalTracks))) el.djInterval.value = String(s.djIntervalTracks)
  } catch (_) {}
  applyDjConfig()
}

/** DJ 界面：完整文案 + 可点击来源；语音不朗读 URL（契约第 3 节）。 */
function showSegueUI(segue) {
  el.segueInfo.hidden = false
  el.segueTarget.textContent = `${segue.script.targetName || ''} — ${segue.script.targetArtists || ''}`
  el.segueScript.textContent = segue.script.scriptText
  el.segueSources.innerHTML = ''
  const sources = segue.script.sources || []
  if (!sources.length) {
    const span = document.createElement('span')
    span.className = 'src-none'
    span.textContent = '本次为基础介绍（无可核对出处）'
    el.segueSources.appendChild(span)
    return
  }
  for (const src of sources) {
    const a = document.createElement('a')
    a.className = 'src-link'
    a.href = src.url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.title = `${src.evidence || ''}（${src.publisherOrAuthor || '未知来源'} · 检索于 ${src.retrievedAt || ''}）`
    a.textContent = src.title || src.url
    el.segueSources.appendChild(a)
  }
}

function hideSegueUI() {
  el.segueInfo.hidden = true
  el.segueScript.textContent = ''
  el.segueSources.innerHTML = ''
}

/** 串场播出失败/被跳过后进入目标歌曲；用户已暂停时只切到待播状态，不自动出声（契约第 6 节）。 */
function continueAfterSegue(decision) {
  const targetId = decision && decision.targetItemId
  let idx = targetId ? state.queue.findIndex((t) => t.itemId === targetId) : -1
  if (idx < 0) idx = state.index + 1
  if (idx < 0 || idx >= state.queue.length) idx = state.index + 1
  if (!userWantsPlayback) {
    // 用户按过暂停：只把目标歌曲挂到待播位置，等他自己点继续，不覆盖暂停意图
    stageTrack(idx)
    setStatus('已暂停；串场已结束，点「继续」播放下一首。', 'warn')
    return
  }
  return playIndex(idx, { userGesture: true })
}

/** 只把界面切到某条歌曲的待播位置：保持暂停、不改媒体源（真正加载发生在用户点继续时）。 */
function stageTrack(index) {
  const track = state.queue[index]
  if (!track) return
  state.resolving = false
  state.index = index
  state.current = track
  state.currentKind = 'track'
  showTrack(track)
  markCurrent()
  el.counter.textContent = `${index + 1} / ${state.queue.length} · ${state.sourceLabel}`
  updateControls()
}

/**
 * 当前媒体里装的是不是界面认定的那条内容。
 * 切歌解析期间媒体里还是上一条（旧歌或 DJ 音频），此时到达的 ended/error 属于旧媒体，
 * 不能当成新条目的自然结束，否则会跳歌并错误计数。
 * 歌曲还要核对播放实例：重播同一首歌时 trackId 不变，只看 id 会把上一次播放的
 * 遗留事件算到这一次头上。
 */
function mediaOwnsCurrent() {
  const src = audio.currentSrc || audio.src || ''
  if (state.currentKind === 'segue') {
    return Boolean(state.segue && src.includes(state.segue.audio.url))
  }
  if (state.current === null || loadedTrackId() !== state.current.trackId) return false
  return mediaPlayInstance !== null && mediaPlayInstance === playTracker.current(state.current.itemId)
}

/** 离开试听模式：媒体被真正的歌曲或播报接管时调用，避免新内容被当成试听。 */
function exitPreviewMode() {
  if (!state.previewing) return
  state.previewing = false
}

/** 播出已就绪的串场成品（同一 audio 出口）。 */
async function playSegue(segue) {
  closePlay('replaced')
  const token = ++playToken
  state.currentKind = 'segue'
  state.segue = segue
  state.segueStarted = false
  state.resolving = false
  showSegueUI(segue)
  updateFeedbackButtons()
  setStatus('DJ 串场…')
  el.title.textContent = 'DJ 串场'
  el.artist.textContent = `接下来：${segue.script.targetName || '下一首'} — ${segue.script.targetArtists || ''}`
  el.album.textContent = ''
  el.duration.textContent = fmt((segue.audio.durationMs || 0) / 1000)
  updateControls()
  playTracker.begin(`sg:${segue.segueId}`)
  audio.src = segue.audio.url + '?t=' + Date.now()
  try {
    await audio.play()
    if (token !== playToken) audio.pause()
  } catch (err) {
    if (token !== playToken) return
    // 从未出声：本轮机会不算使用（计数保持到期），直接进目标歌曲
    const d = segueCtl.onSegueFailed({ segueId: segue.segueId, started: false, at: Date.now() })
    state.segue = null
    state.currentKind = 'track'
    hideSegueUI()
    updateFeedbackButtons()
    setStatus('串场播放失败，继续播放歌曲。', 'warn')
    renderDjStatus()
    return continueAfterSegue(d)
  }
}

/** 停止收听时的主动试听：同一 audio 出口，不进节目队列、不记历史、不改计数。 */
async function previewVoice() {
  if (state.sessionId) {
    setDjStatus('停止收听后才能试听音色，避免打断节目。', 'warn')
    return
  }
  const referenceId = el.previewVoice.value.trim()
  if (!referenceId) {
    setDjStatus('先填写要试听的音色 reference_id。', 'warn')
    return
  }
  const previewReq = ++previewSeq
  setDjStatus('正在合成试听…')
  try {
    const res = await fetch('/api/dj/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ referenceId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      setDjStatus(`试听失败（${data.code || res.status}）：${data.message || ''}`, 'bad')
      return
    }
    // 合成期间用户可能已经开播、暂停或又点了一次试听：迟到结果不能替换媒体、越过暂停
    if (previewReq !== previewSeq || state.sessionId) {
      setDjStatus('试听结果已过期，未打断当前收听。', 'warn')
      return
    }
    playToken += 1
    state.previewing = true
    el.title.textContent = '音色试听'
    el.artist.textContent = referenceId
    el.album.textContent = ''
    const token = playToken
    audio.src = data.audio.url + '?t=' + Date.now()
    await audio.play()
    if (token !== playToken) audio.pause()
    setDjStatus(
      `试听播放中（约 ${(data.audio.durationMs / 1000).toFixed(1)} 秒）。满意就点「设为正式音色」。`,
      'ok',
    )
    el.previewSave.disabled = false
  } catch (err) {
    state.previewing = false
    setDjStatus('试听播放失败：' + err.message, 'bad')
  }
}

async function saveChosenVoice() {
  const referenceId = el.previewVoice.value.trim()
  if (!referenceId) return
  if (!(await saveDjSetting('djVoiceReferenceId', referenceId))) return
  el.previewSave.disabled = true
  applyDjConfig({ voiceUpdated: true })
  if (djVoiceConfig && !djVoiceConfig.ready) renderDjStatus()
  else setDjStatus(`已把 ${referenceId} 设为正式音色，之后的串场都会用它。`, 'ok')
}

el.previewBtn.onclick = () => previewVoice()
el.previewSave.onclick = () => saveChosenVoice()
el.djEnabled.onchange = () => {
  saveDjSetting('djEnabled', el.djEnabled.checked ? 'true' : 'false')
  applyDjConfig()
  if (!el.djEnabled.checked) endSegueOnDjDisabled()
}

/** 关闭 DJ：结束正在播报的串场并进入目标歌曲；暂停中只切到待播状态（契约第 6 节）。 */
function endSegueOnDjDisabled() {
  const sg = state.segue
  if (state.currentKind !== 'segue' || !sg) return
  if (!audio.paused) audio.pause()
  playTracker.markEnded(playTracker.current(`sg:${sg.segueId}`))
  const d = segueCtl.onSegueSkipped({ segueId: sg.segueId, at: Date.now() })
  state.segue = null
  state.currentKind = 'track'
  hideSegueUI()
  updateFeedbackButtons()
  renderDjStatus()
  return continueAfterSegue(d)
}
el.djInterval.onchange = () => {
  saveDjSetting('djIntervalTracks', el.djInterval.value)
  applyDjConfig()
}

/* ---------- 后台补歌编排（队列、补歌、意图、退避收敛在这里） ---------- */

function pendingCount() {
  // 待播数量只数歌曲条目；串场不进队列
  return Math.max(0, state.queue.slice(state.index + 1).filter((t) => !t.type || t.type === 'track').length)
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

/** 新增队列要排除：当前曲、已排队曲、已失败曲（全部按歌曲平台 id）。 */
function getRefillExclusion() {
  const ids = new Set()
  if (state.current && state.currentKind === 'track') ids.add(Number(state.current.trackId))
  for (let i = state.index + 1; i < state.queue.length; i += 1) ids.add(Number(state.queue[i].trackId))
  for (const id of state.failedIds) ids.add(Number(id))
  return [...ids].filter((n) => Number.isFinite(n))
}

function setPrepStatus(text, cls = '') {
  if (!el.prep) return
  el.prep.textContent = text
  el.prep.className = 'status prep' + (cls ? ' ' + cls : '')
}

/** 只追加、不替换；去重范围与发给服务端的排除范围完全一致（当前曲 + 待播 + 已失败）。 */
function appendPicks(picks) {
  const known = new Set(getRefillExclusion())
  const added = []
  for (const p of picks) {
    const id = Number(p.id)
    if (!Number.isFinite(id) || known.has(id)) continue
    known.add(id)
    added.push(contract.makeTrackItem({ ...p, auto: true }))
  }
  if (added.length) {
    state.queue = state.queue.concat(added)
    renderTracks()
    updateControls()
    el.counter.textContent = `${state.index + 1} / ${state.queue.length} · ${state.sourceLabel}`
    // 队列变化可能带来新的紧邻下一首：交给控制器重新评估准备时机
    segueCtl.onQueueChanged({ next: state.queue[state.index + 1] || null, at: Date.now() })
    renderDjStatus()
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
    if (!added.length) return added // 实际追加 0 首：交给控制器按失败处理，不能在这里跳到队尾继续播
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
    return added
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
      currentId: state.current ? state.current.trackId : null,
      currentItemId: state.current ? state.current.itemId : null,
      currentTitle: state.current ? state.current.name : null,
      currentKind: state.currentKind,
      index: state.index,
      queueLength: state.queue.length,
      started: state.started,
      audioSrc: audio.currentSrc || audio.src || '',
      loadedTrackId: loadedTrackId(),
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
      queueIds: state.queue.map((t) => t.trackId),
      queueItemIds: state.queue.map((t) => t.itemId),
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
      autoQueueIds: state.queue.filter((t) => t.auto).map((t) => t.trackId),
      // —— DJ 串场 ——
      dj: segueCtl.snapshot(),
      djStatus: el.djStatus.textContent,
      segue: state.segue
        ? {
            segueId: state.segue.segueId,
            targetTrackId: state.segue.script.targetTrackId,
            targetItemId: state.segue.script.targetItemId,
            scriptText: state.segue.script.scriptText,
            sources: state.segue.script.sources,
            audioUrl: state.segue.audio.url,
            durationMs: state.segue.audio.durationMs,
            started: state.segueStarted,
          }
        : null,
      previewing: state.previewing,
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
  dj() {
    return segueCtl.snapshot()
  },
  djApplyConfig(patch) {
    return segueCtl.setConfig(patch)
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
  // 适配为节目条目：同一首歌重复入队也各有 itemId
  state.queue = tracks.filter((t) => t.id).map((t) => contract.makeTrackItem(t))
  state.sourceLabel = label
  state.index = -1
  state.current = null
  state.stopped = false
  state.consecutiveFailures = 0
  state.segue = null
  state.currentKind = 'track'
  hideSegueUI()
  // 编排版本更新：串场机会关闭、计数清零、在途作废
  segueCtl.setEpoch(segueEpoch() + 1)
  renderTracks()
  updateControls()
  renderDjStatus()
  el.counter.textContent = state.queue.length ? `0 / ${state.queue.length} · ${label}` : ''
}

function renderTracks() {
  el.tracks.innerHTML = ''
  state.queue.forEach((t, i) => {
    const row = document.createElement('div')
    row.className = 'track'
    row.dataset.id = t.trackId
    row.dataset.itemId = t.itemId
    row.dataset.index = i
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
    // 允许同一首歌重复入队（历史曲目被重新补入），当前曲按位置标记而不是按 id
    row.classList.toggle('current', Number(row.dataset.index) === state.index)
    row.classList.toggle('failed', state.failedIds.has(id))
    row.classList.toggle('codex', state.codexPicks.some((p) => p.id === id))
    row.classList.toggle('liked', state.feedback.get(id) === 'like')
    row.classList.toggle('disliked', state.feedback.get(id) === 'dislike')
    const qi = Number(row.dataset.index)
    row.classList.toggle('auto', Boolean(state.queue[qi] && state.queue[qi].auto))
  })
  updateFeedbackButtons()
}

function updateControls() {
  const has = state.queue.length > 0
  el.play.disabled = !has && !state.previewing
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
    // 队列里不该出现的类型：明确跳过而不是假装能播
    setStatus(`队列里的「${queued.type}」类型内容暂未实现，已跳过。`, 'warn')
    state.index = index
    return playIndex(index + 1, { userGesture: true })
  }

  // 接下来媒体要装歌曲内容：退出试听态，否则这首歌会被当成试听（不记历史、结束不接下一首）
  exitPreviewMode()
  // 切到新一首前先结束上一条播放记录，并确保有会话。
  closePlay('replaced')
  if (!state.sessionId) await ensureSession()

  // 取一个代次号；并发切歌时只有最后一次意图对应的结果允许生效
  const token = ++playToken
  userWantsPlayback = true
  state.resolving = true

  const track = state.queue[index]
  state.index = index
  state.current = track
  state.currentKind = 'track'
  state.refreshedCurrent = false
  markCurrent()
  showTrack(track)
  el.counter.textContent = `${index + 1} / ${state.queue.length} · ${state.sourceLabel}`
  setStatus(`解析音源：${track.name}…`)
  updateControls()

  // 进入歌曲：登记播放实例并通知串场控制器（达到间隔时会触发提前准备）
  const pi = playTracker.begin(track.itemId)
  segueCtl.onTrackStarted({
    item: track,
    next: state.queue[index + 1] || null,
    playInstanceId: pi,
    at: Date.now(),
  })
  // 用户点歌/点下一首同样是“恢复收听”：控制器必须解除暂停，否则之后再也不会准备串场
  segueCtl.onResumed({ at: Date.now() })
  renderDjStatus()

  let r
  try {
    r = await resolveTrack(track.trackId)
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
  // 媒体里装的就是这次播放实例的音频，后续事件按这个实例归属
  mediaPlayInstance = pi
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
  state.failedIds.add(track.trackId)
  state.failureCount += 1
  state.lastError = { id: track.trackId, name: track.name, reason }
  state.consecutiveFailures += 1
  markCurrent()

  // 播放失败不累计串场计数；机会随下一次进入歌曲重建
  segueCtl.onTrackFailed({ item: track, at: Date.now() })
  renderDjStatus()

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
  // DJ 播报中点「下一首」：结束播报并开始它后面那首歌（Q3）
  if (state.currentKind === 'segue' && state.segue) {
    const sg = state.segue
    if (!audio.paused) audio.pause()
    playTracker.markEnded(playTracker.current(`sg:${sg.segueId}`))
    segueCtl.onSegueSkipped({ segueId: sg.segueId, at: Date.now() })
    state.segue = null
    state.currentKind = 'track'
    hideSegueUI()
    updateFeedbackButtons()
    const targetIdx = state.index + 1
    if (targetIdx >= state.queue.length) {
      // DJ 介绍的是队尾补歌目标：按队尾逻辑等待补歌结果
      return next({ userGesture })
    }
    return playIndex(targetIdx, { userGesture })
  }
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
  // 手动下一首不累计串场计数；旧机会关闭、在途准备取消
  segueCtl.onSkipped({ at: Date.now() })
  closePlay('skipped')
  playIndex(nextIndex, { userGesture })
}

/* ---------- 事件（按当前媒体身份分派给控制器） ---------- */

audio.addEventListener('playing', () => {
  if (state.previewing) {
    updateControls()
    return
  }
  // 出声事件属于实际装载的播放实例，不能替仍在解析的新条目记账。
  if (!mediaOwnsCurrent()) return
  if (state.currentKind === 'segue' && state.segue) {
    state.started = true
    state.stopped = false
    const sg = state.segue
    const first = playTracker.markPlaying(playTracker.current(`sg:${sg.segueId}`))
    if (first) state.segueStarted = true
    segueCtl.onSeguePlaying({ segueId: sg.segueId, at: Date.now() })
    setStatus('DJ 串场播放中…', 'playing')
    updateControls()
    renderDjStatus()
    return
  }
  state.started = true
  state.consecutiveFailures = 0
  state.stopped = false
  const pi = playTracker.current(state.current ? state.current.itemId : null)
  const firstPlaying = playTracker.markPlaying(pi)
  setStatus(`播放中：${state.current.name} — ${state.current.artists}`, 'playing')
  updateControls()
  if (firstPlaying) notePlayStart() // 只有首次出声记一条播放记录，暂停恢复不重复记
  // 正在出声才考虑提前准备下一批；暂停时不主动发新的生成请求
  refillController.resume()
  refillController.check()
})

audio.addEventListener('ended', () => {
  const ev = {
    type: 'ended',
    kind: state.currentKind,
    id: state.current ? state.current.trackId : null,
    at: Date.now(),
    currentTime: audio.currentTime,
    duration: audio.duration,
  }
  window.__radio.events = (window.__radio.events || []).concat([ev])

  if (state.previewing) {
    state.previewing = false
    setStatus('试听结束。')
    updateControls()
    return
  }

  if (!mediaOwnsCurrent()) {
    // 旧媒体（已被换下的 DJ 音频、上一条歌曲）遗留的 ended：不算任何自然结束
    ev.ignored = 'media_mismatch'
    return
  }

  if (state.currentKind === 'segue' && state.segue) {
    const sg = state.segue
    playTracker.markEnded(playTracker.current(`sg:${sg.segueId}`))
    const d = segueCtl.onSegueEnded({ segueId: sg.segueId, at: Date.now() })
    state.segue = null
    state.currentKind = 'track'
    hideSegueUI()
    updateFeedbackButtons()
    setStatus('串场结束，进入下一首。', 'ok')
    renderDjStatus()
    return continueAfterSegue(d)
  }

  // 歌曲：只有当前播放实例的有效自然结束才累计一次
  const item = state.current
  const pi = playTracker.current(item ? item.itemId : null)
  const validEnd = playTracker.markEnded(pi)
  const d = segueCtl.onTrackEnded({ item, playInstanceId: pi, natural: validEnd, at: Date.now() })
  renderDjStatus()
  closePlay('ended')
  if (d && d.type === 'play-segue') {
    // 达到间隔且串场就绪：播出 DJ，不再走下一首
    return playSegue(d.segue)
  }
  setStatus('播放结束，自动下一首。', 'ok')
  next()
})

audio.addEventListener('error', () => {
  if (state.previewing) {
    state.previewing = false
    setStatus('试听播放失败：媒体错误。', 'warn')
    return
  }
  if (!mediaOwnsCurrent()) {
    // 旧媒体（已被换下的 DJ 音频、上一条歌曲）的报错不属于当前条目：
    // 不能借此刷新或判定尚未播放的新歌失败
    return
  }
  if (state.currentKind === 'segue' && state.segue) {
    const sg = state.segue
    const started = state.segueStarted
    playTracker.markEnded(playTracker.current(`sg:${sg.segueId}`))
    const d = segueCtl.onSegueFailed({ segueId: sg.segueId, started, at: Date.now() })
    state.segue = null
    state.currentKind = 'track'
    hideSegueUI()
    updateFeedbackButtons()
    setStatus('串场播放失败，继续播放歌曲。', 'warn')
    renderDjStatus()
    // 语音错误不算歌曲失败，不计入连续歌曲失败
    return continueAfterSegue(d)
  }
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
    const r = await resolveTrack(track.trackId, true)
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
  // 暂停可保留在途串场结果，但不启动新准备、不让结果出声
  segueCtl.onPaused({ at: Date.now() })
  renderDjStatus()
  // 后台补歌不因暂停而中断，但结果只会追加进队列，不会自动出声
  if (refillController.isPreparing()) {
    setPrepStatus('已暂停；后台仍在准备下一批，迟到结果不会自动出声。', 'warn')
  }
  updateControls()
}

/** 当前 <audio> 里实际装着哪首歌（切歌解析期间它可能还是上一首）。 */
function loadedTrackId() {
  const src = audio.currentSrc || audio.src || ''
  if (src.includes('/api/dj/audio/')) return null // DJ 音频不是歌曲
  const m = src.match(/\/api\/audio\/(\d+)/)
  return m ? Number(m[1]) : null
}

el.play.onclick = async () => {
  // 正在解析（加载中）也允许暂停：这里必须取消在途请求，否则结果回来后会把播放重新拉起
  if (state.resolving || (state.started && !audio.paused)) {
    pausePlayback()
    return
  }
  // DJ 串场暂停后的恢复：从原位置继续，不重新计数
  if (state.currentKind === 'segue' && state.segue) {
    playToken += 1
    userWantsPlayback = true
    playTracker.resume(`sg:${state.segue.segueId}`)
    // 控制器必须一起解除暂停，否则后续歌曲达到阈值也不会再准备串场
    segueCtl.onResumed({ at: Date.now() })
    renderDjStatus()
    try {
      await audio.play()
    } catch (err) {
      setStatus('浏览器拒绝播放：' + err.message, 'bad')
    }
    updateControls()
    return
  }
  // 只有“已经装进播放器的就是列表当前这首”时才能直接续播。
  // 切歌加载中暂停过的话，播放器里还是上一首，直接续播会变成界面显示新歌、实际放旧歌。
  const loaded = loadedTrackId()
  const currentTrackId = state.current ? state.current.trackId : null
  if (loaded && loaded === currentTrackId && audio.currentTime > 0) {
    playToken += 1
    userWantsPlayback = true
    if (state.sessionId) {
      playTracker.resume(state.current.itemId)
    } else {
      // 停止收听之后的重开：直接续播会绕过会话创建与播放记录，这里补齐，
      // 但仍从原位置继续，不重头播这首歌。
      await ensureSession()
      playTracker.begin(state.current.itemId)
    }
    // 这里继续播放的是媒体里已装载的音频：登记到当前播放实例，它的自然结束才算数
    mediaPlayInstance = playTracker.current(state.current.itemId)
    segueCtl.onResumed({ at: Date.now() })
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
      const qi = state.queue.findIndex((t) => t.trackId === p.id)
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
  const picks = data.picks.map((p) => contract.makeTrackItem({ ...p, fromCodex: true }))
  const current = state.current
  state.queue = current ? [current, ...picks] : picks
  state.index = current ? 0 : -1
  state.codexPicks = picks
  state.sourceLabel = 'Codex 选歌'
  state.stopped = false
  state.consecutiveFailures = 0
  segueCtl.setEpoch(segueEpoch() + 1)
  renderTracks()
  renderCodexPicks(picks)
  updateControls()
  el.counter.textContent = `${current ? 1 : 0} / ${state.queue.length} · ${state.sourceLabel}`
  segueCtl.onQueueChanged({ next: state.queue[state.index + 1] || null, at: Date.now() })
  renderDjStatus()
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
  // 开播即播放意图变更：作废在途的试听请求
  previewSeq += 1
  try {
    const res = await fetch('/api/session/start', { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      state.sessionId = data.session.id
      state.adjustments = data.session.adjustments || {}
      segueCtl.startSession({ sessionId: state.sessionId, epoch: segueEpoch() })
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
  // 停止收听即播放意图变更：作废在途的试听请求，迟到的合成结果不能自己出声
  previewSeq += 1
  state.resolving = false
  state.awaitingRefill = false
  // 停止 = 作废旧意图：在途补歌结果作废，也不会落到下一次会话
  refillController.cancel('stopped', { reset: true })
  if (!audio.paused) audio.pause()
  // 停止清空串场机会、计数与任务绑定
  segueCtl.onStopped({ at: Date.now() })
  state.segue = null
  state.currentKind = 'track'
  hideSegueUI()
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
  renderDjStatus()
  updateFeedbackButtons()
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
  // 只有歌曲记播放记录；DJ 串场与试听不写 plays
  if (state.playId || !state.current || state.currentKind !== 'track' || state.previewing) return
  try {
    const res = await fetch('/api/plays/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackId: state.current.trackId,
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
      segueCtl.startSession({ sessionId: state.sessionId, epoch: segueEpoch() })
      setStatus('已连上正在进行的收听会话，点“继续”接着听。')
    }
  } catch (_) {}
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
  // DJ 播报期间禁用歌曲反馈：这是串场，不是歌
  const duringSegue = state.currentKind === 'segue'
  const id = state.current && !duringSegue ? state.current.trackId : null
  const sentiment = id ? state.feedback.get(id) : null
  el.like.disabled = duringSegue
  el.dislike.disabled = duringSegue
  el.unlike.disabled = duringSegue || !sentiment
  el.like.classList.toggle('active', sentiment === 'like')
  el.dislike.classList.toggle('active', sentiment === 'dislike')
}

async function saveFeedback(sentiment) {
  if (!state.current || state.currentKind === 'segue') return
  const t = state.current
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trackId: t.trackId,
        trackName: t.name,
        artists: t.artists,
        sentiment,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`)
    state.feedback.set(t.trackId, sentiment)
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
  if (!state.current || state.currentKind === 'segue') return
  const t = state.current
  try {
    const res = await fetch('/api/feedback/' + t.trackId, { method: 'DELETE' })
    const data = await res.json()
    if (data.ok) {
      state.feedback.delete(t.trackId)
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
loadDjSettings()
reattachSession()
updateControls()
renderDjStatus()
updateFeedbackButtons()
