/**
 * 节目编排层：把「候选抽样 → Codex 选歌 → 可播性校验 → 自动补歌协调」收敛到一处。
 *
 * 设计边界（对应本次范围，不提前搭建 DJ/播报框架）：
 *  - 只负责「准备下一批可播内容」，不持有播放器，也不直接操作 <audio>。
 *  - 复用现有音乐接入（server/netease.js）、Codex 适配层（server/codex.js）与
 *    持久化（server/db.js），不新增并行播放器或第二套选歌实现。
 *  - 队列本身仍在网页端（现在只有它掌握音频元素）；服务端只保证：同一会话同一意图
 *    不会并发生成多批、过期意图的结果会作废、停止的会话结果不会返回给下一次会话。
 *  - 队列条目统一带 type 字段；本阶段只有 'track'，为后续「歌曲与播报统一编排」留出位置，
 *    但播报能力未实现，不在响应里伪造。
 *
 * 失败策略：
 *  - Codex 超时/额度不足/输出无效：不阻塞已有音乐，降级为「从曲库候选里挑可播的」；
 *    同时给 Codex 记一段退避冷却（指数增长、有上限），冷却期内不再调用订阅。
 *  - 候选被排除后为空：明确报 candidates_exhausted，让界面说清「候选不足」，不无限重试。
 *  - 全部候选都不可播或音乐接口报错：分别报 no_playable / music_unavailable。
 */
const ncm = require('./netease')
const codex = require('./codex')
const db = require('./db')

/** 每个待补名额最多多探几首候选，避免为了凑满一批做无休止的可播性查询。 */
const FALLBACK_PROBE_FACTOR = 3

function normalizeIdSet(ids) {
  const set = new Set()
  for (const id of ids || []) {
    const n = Number(id)
    if (Number.isFinite(n)) set.add(n)
  }
  return set
}

/**
 * 带权不放回抽样。权重来自设置项与最近播放记录：
 *  - 喜欢提高权重，不喜欢降低权重（降低而不是封禁）
 *  - 最近播过的曲降权，避免短时间重复
 *  - excludeIds 内的曲直接不进入候选（当前曲、已排队曲、失败曲）
 * 纯函数式可注入随机数，便于确定性测试。
 */
function sampleCandidates(tracks, n, opts = {}) {
  const {
    excludeIds,
    rand = Math.random,
    feedback = db.activeFeedbackMap(),
    likeBoost = db.getNumberSetting('feedbackLikeBoost', 2),
    dislikePenalty = db.getNumberSetting('feedbackDislikePenalty', 0.1),
    avoidWindowMs = db.getNumberSetting('avoidRepeatWindowMin', 45) * 60 * 1000,
    recentIds,
  } = opts

  const excluded = normalizeIdSet(excludeIds)
  const recent =
    recentIds !== undefined
      ? new Set(recentIds || [])
      : avoidWindowMs > 0
        ? new Set(db.recentlyPlayedIds(avoidWindowMs))
        : new Set()

  const pool = []
  for (const t of tracks || []) {
    const id = Number(t && t.id)
    if (!Number.isFinite(id) || excluded.has(id)) continue
    let weight = 1
    const sentiment = feedback.get(id)
    if (sentiment === 'like') weight *= likeBoost
    if (sentiment === 'dislike') weight *= dislikePenalty
    if (recent.has(id)) weight *= 0.2
    pool.push({ track: t, weight: Math.max(weight, 0.001) })
  }

  const want = Math.max(0, Math.min(Number(n) || 0, pool.length))
  const picked = []
  for (let i = 0; i < want && pool.length; i += 1) {
    const total = pool.reduce((a, x) => a + x.weight, 0)
    let r = rand() * total
    let idx = 0
    for (let j = 0; j < pool.length; j += 1) {
      r -= pool[j].weight
      if (r <= 0) {
        idx = j
        break
      }
    }
    picked.push(pool[idx].track)
    pool.splice(idx, 1)
  }
  return picked
}

/** 逐首做可播性二次校验：模型给的 id 只是候选，不能当作可播音源。 */
async function checkPlayable(items) {
  const out = []
  for (const item of items) {
    let playable = false
    let kind = 'error'
    let error = null
    try {
      const info = await ncm.resolveTrack(item.id)
      kind = info.kind
      playable = info.kind === 'full'
    } catch (err) {
      kind = 'error'
      error = err.message
    }
    out.push({ ...item, type: 'track', kind, playable, error })
  }
  return out
}

/* ---------- 自动补歌协调状态 ---------- */

// 每个会话同一时刻最多一个在途生成任务：重复请求复用同一个 Promise，不会重复调 Codex。
const inflight = new Map() // sessionId -> { epoch, promise, invalidated }
// 在途请求的 epoch 水位：生成期间，比它旧的请求一律拒绝，
// 避免迟到的旧请求把更新的编排意图取消掉再自己重跑一遍。
const activeEpoch = new Map() // sessionId -> epoch
// Codex 失败后的退避冷却，避免紧密重试和额度空转。
const cooldowns = new Map() // sessionId -> { failures, until }

function isSessionOpen(sessionId) {
  if (!sessionId) return false
  try {
    const s = db.getSession(sessionId)
    return Boolean(s && !s.ended_at)
  } catch (_) {
    return false
  }
}

/** 会话停止/切换时调用：让在途任务的结果失效，并清掉该会话的冷却状态。 */
function invalidateSession(sessionId) {
  if (!sessionId) return false
  const entry = inflight.get(sessionId)
  if (entry) entry.invalidated = true
  inflight.delete(sessionId)
  activeEpoch.delete(sessionId)
  cooldowns.delete(sessionId)
  return Boolean(entry)
}

function cooldownState(sessionId) {
  return cooldowns.get(sessionId) || { failures: 0, until: 0 }
}

function noteCodexFailure(sessionId) {
  const base = db.getNumberSetting('codexFailureCooldownMs', 60000)
  const max = db.getNumberSetting('codexFailureCooldownMaxMs', 900000)
  const prev = cooldownState(sessionId)
  const failures = prev.failures + 1
  const until = Date.now() + Math.min(base * 2 ** (failures - 1), max)
  cooldowns.set(sessionId, { failures, until })
  return { failures, until }
}

/**
 * 降级续播：从已经取得的曲库候选里挑可播的。
 * 只探测有上限的候选数；同时区分「都不好播」和「音乐接口整体报错」。
 */
async function pickFromLibrary(sampled, excludeIds, count) {
  const excluded = normalizeIdSet(excludeIds)
  const limit = Math.min(sampled.length, Math.max(1, count) * FALLBACK_PROBE_FACTOR)
  const picks = []
  const dropped = []
  let resolved = 0
  let errored = 0

  for (let i = 0; i < limit && picks.length < count; i += 1) {
    const track = sampled[i]
    const id = Number(track && track.id)
    if (!Number.isFinite(id) || excluded.has(id)) continue
    let info = null
    try {
      info = await ncm.resolveTrack(id)
      resolved += 1
    } catch (err) {
      errored += 1
      dropped.push({ id, why: '可播性查询失败：' + err.message })
      continue
    }
    if (info.kind !== 'full') {
      dropped.push({ id, why: info.kind === 'trial' ? '只有试听片段权限' : '账号当前无播放权限' })
      continue
    }
    picks.push({
      id,
      name: track.name,
      artists: track.artists,
      album: track.album,
      durationMs: track.durationMs,
      type: 'track',
      kind: info.kind,
      playable: true,
      fromCodex: false,
      reason: '按你的口味从红心歌曲里选（Codex 暂不可用时的降级续播）',
    })
  }

  if (picks.length) return { ok: true, picks, dropped, examined: resolved + errored }
  if (resolved === 0 && errored > 0) {
    return {
      ok: false,
      code: 'music_unavailable',
      message: `音乐服务查询失败（尝试 ${errored} 首都没成功），暂时无法补歌`,
      dropped,
    }
  }
  return {
    ok: false,
    code: 'no_playable',
    message: '曲库候选里没有可完整播放的歌曲',
    dropped,
  }
}

/** 单个在途任务的真实生成流程。调用方已保证同一会话同一意图不会并发进入。 */
async function runPrepare(opts, entry) {
  const started = Date.now()
  const {
    library,
    sessionId,
    excludeIds = [],
    count = db.getNumberSetting('refillBatchSize', 5),
    brief = '',
    timeoutMs,
    skipCodex = false,
    rand = Math.random,
  } = opts

  const superseded = () => ({
    ok: false,
    code: 'superseded',
    message: '已有更新的编排意图，本次补歌结果作废',
  })
  const ended = () => ({
    ok: false,
    code: 'session_ended',
    message: '收听会话已结束，本次补歌结果作废',
  })
  const checkAlive = () => {
    if (entry.invalidated) return superseded()
    if (!isSessionOpen(sessionId)) return ended()
    return null
  }

  if (!Array.isArray(library) || library.length === 0) {
    return { ok: false, code: 'library_empty', message: '没有读到红心歌曲，无法补歌' }
  }

  const excluded = normalizeIdSet(excludeIds)
  const candidateCount = db.getNumberSetting('candidateCount', 60)
  const sampled = sampleCandidates(library, candidateCount, { excludeIds: excluded, rand })
  if (!sampled.length) {
    return {
      ok: false,
      code: 'candidates_exhausted',
      message: `排除当前与已排队歌曲后，曲库里没有新的候选了（已排除 ${excluded.size} 首）`,
      meta: { available: 0, excluded: excluded.size, librarySize: library.length },
    }
  }

  const cd = cooldownState(sessionId)
  const inCooldown = Date.now() < cd.until
  const wantCodex = !skipCodex && !inCooldown
  let codexResult = null

  if (wantCodex) {
    codexResult = await codex.pickTracks({ candidates: sampled, brief, count, timeoutMs })
    const dead = checkAlive()
    if (dead) return dead
    if (codexResult.ok) {
      cooldowns.delete(sessionId)
    } else {
      noteCodexFailure(sessionId)
    }
  }

  // 1) Codex 成功：用它的结果，但必须逐首过可播性
  if (codexResult && codexResult.ok) {
    const checked = await checkPlayable(codexResult.picks)
    const dead = checkAlive()
    if (dead) return dead
    const playable = checked.filter((c) => c.playable)
    if (playable.length) {
      return {
        ok: true,
        picks: playable.slice(0, count),
        dropped: checked.filter((c) => !c.playable),
        rejected: codexResult.rejected || [],
        source: 'codex',
        degraded: false,
        meta: {
          durationMs: Date.now() - started,
          candidates: sampled.length,
          excluded: excluded.size,
          codex: codexResult.meta || {},
        },
      }
    }
    // Codex 选的都不好播：不整批失败，回到曲库候选里继续找
    const fallback = await pickFromLibrary(sampled, excluded, count)
    const dead2 = checkAlive()
    if (dead2) return dead2
    if (fallback.ok) {
      return {
        ok: true,
        picks: fallback.picks,
        dropped: [...(fallback.dropped || []), ...checked],
        rejected: codexResult.rejected || [],
        source: 'library',
        degraded: true,
        reason: 'codex_picks_unplayable',
        message: 'Codex 选的歌曲当前都不可完整播放，已改用曲库候选续播',
        meta: { durationMs: Date.now() - started, candidates: sampled.length, excluded: excluded.size, codex: codexResult.meta || {} },
      }
    }
    return { ...fallback, rejected: codexResult.rejected || [] }
  }

  // 2) Codex 不可用（失败 / 冷却中 / 显式跳过）：用曲库候选降级续播
  const fallback = await pickFromLibrary(sampled, excluded, count)
  const dead = checkAlive()
  if (dead) return dead
  if (!fallback.ok) return fallback
  return {
    ok: true,
    picks: fallback.picks,
    dropped: fallback.dropped || [],
    rejected: codexResult ? codexResult.rejected || [] : [],
    source: 'library',
    degraded: true,
    reason: codexResult ? codexResult.code : inCooldown ? 'codex_cooldown' : 'codex_skipped',
    message: codexResult
      ? `Codex 暂不可用（${codexResult.code}），已用曲库候选续播`
      : 'Codex 正在退避冷却，已用曲库候选续播',
    meta: {
      durationMs: Date.now() - started,
      candidates: sampled.length,
      excluded: excluded.size,
      codex: codexResult ? codexResult.meta || {} : { skipped: true, inCooldown },
      cooldownUntil: cooldownState(sessionId).until,
    },
  }
}

/**
 * 准备一批内容。
 *
 * 并发语义（对应「避免同时重复生成多批」与「新意图作废旧结果」）：
 *  - 同一 sessionId + 同一 epoch 的重复请求：复用同一个在途 Promise，不会重复调用。
 *  - 同一 sessionId + 更大的 epoch：旧任务标记作废，新任务立即开始。
 *  - 同一 sessionId + 更小的 epoch（乱序到达的旧请求）：直接拒绝，不影响在途的新任务。
 *  - 会话已结束：直接拒绝，不产生结果。
 */
async function prepareBatch(opts = {}) {
  const sessionId = opts.sessionId
  const epoch = Number(opts.epoch) || 0

  if (!isSessionOpen(sessionId)) {
    return { ok: false, code: 'session_ended', message: '没有进行中的收听会话，补歌请求已忽略' }
  }

  const existing = inflight.get(sessionId)
  if (existing) {
    if (existing.epoch === epoch) {
      const result = await existing.promise
      return { ...result, deduped: true }
    }
    if (epoch < existing.epoch) {
      // 过期请求（乱序到达的旧意图）：直接拒绝，
      // 绝不能让它把更新的在途任务取消掉、再自己重跑一遍浪费订阅。
      return {
        ok: false,
        code: 'superseded',
        message: `补歌请求已过期（epoch ${epoch} 早于在途的 ${existing.epoch}），同一会话已有更新的编排意图在生成`,
      }
    }
    // epoch 更大才是「新意图取代旧任务」
    existing.invalidated = true
    inflight.delete(sessionId)
  }

  activeEpoch.set(sessionId, epoch)
  const entry = { epoch, invalidated: false, startedAt: Date.now() }
  const promise = runPrepare(opts, entry).catch((err) => ({
    ok: false,
    code: 'internal_error',
    message: String((err && err.message) || err),
  }))
  entry.promise = promise
  inflight.set(sessionId, entry)
  try {
    return await promise
  } finally {
    if (inflight.get(sessionId) === entry) {
      inflight.delete(sessionId)
      // 水位只在生成期间有效：结束后不阻塞后续请求（页面刷新后 epoch 会重新计时）
      if (activeEpoch.get(sessionId) === epoch) activeEpoch.delete(sessionId)
    }
  }
}

function inflightInfo() {
  return [...inflight.entries()].map(([sessionId, e]) => ({
    sessionId,
    epoch: e.epoch,
    startedAt: e.startedAt,
  }))
}

module.exports = {
  sampleCandidates,
  checkPlayable,
  prepareBatch,
  invalidateSession,
  isSessionOpen,
  inflightInfo,
}
