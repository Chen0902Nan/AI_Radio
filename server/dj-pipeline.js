/**
 * DJ 准备流水线（任务 05）：把「目标音源校验 → 搜索文案 → 语音合成 → 缓存发布」
 * 串成一条有限时间的任务，并以进程内状态对外提供查询/取消/试听。
 *
 * 约束（契约第 5 节）：
 *  - 同一个 (sessionId, epoch, transitionId) 的重复提交复用任务；
 *    相同键不同 payload 明确拒绝（payload_conflict），绝不悄悄复用。
 *  - 同一会话最多一条有效 DJ 准备流水线；新机会自动把旧机会作废（stale/superseded）。
 *  - 总截止 150 秒、文案 90 秒、合成 60 秒（受同一总截止约束）；取消/过期结果
 *    不重新激活任务，旧任务的收尾也绝不触碰新任务（每步都核对任务自身状态）。
 *  - 文案失败、语音失败、歌曲失败分开记录；临时失败按 60s 倍增至 15min 有界冷却，
 *    配置/认证类失败在配置更新前直接阻塞；冷却期间音乐照常。
 *  - 没有免费语音配置时提前返回 voice_not_configured，不消耗 Codex 额度。
 *  - 目标歌曲完整音源在准备开始与使用前校验；ready 成品经 program-contract 校验，
 *    携带完整媒体/目标身份与版本。
 *  - 任务状态仅存进程内；完成后保留 5 分钟供查询，过期按失效处理。音频成品
 *    独立由音频缓存（TTL/容量）管理，路由只经 /api/dj/audio/:assetId 同源提供。
 *
 * 依赖全部可注入（djScript / fish / cache / resolveTarget / settings / getApiKey / now），
 * 测试用替身即可覆盖，不需要真实 Codex、Fish 或音乐账号。
 */
const contract = require('../public/program-contract')
const fishMod = require('./fish')
const cacheMod = require('./dj-audio-cache')
const djScriptMod = require('./dj-script')

const LIMITS = {
  scriptMs: Number(process.env.DJ_SCRIPT_TIMEOUT_MS) || 90000,
  ttsMs: Number(process.env.FISH_TTS_TIMEOUT_MS) || 60000,
  totalMs: 150000,
  retentionMs: 5 * 60 * 1000,
}
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
const CONFIG_BLOCK_CODES = ['not_configured', 'auth', 'unknown_model', 'invalid_reference']
const PREVIEW_TEXT = '你好，这是一段音色试听。接下来的歌，讲一个它的故事。'

function createDjPipeline(deps = {}) {
  const settings = deps.settings || (() => ({}))
  const getApiKey = deps.getApiKey || (() => process.env.FISH_API_KEY || process.env.FISH_AUDIO_API_KEY || null)
  const djScript = deps.djScript || djScriptMod
  const fish = deps.fish || fishMod
  const resolveTarget = deps.resolveTarget || (async () => ({ kind: 'full' }))
  const now = deps.now || (() => Date.now())
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t))
  const limits = { ...LIMITS, ...(deps.limits || {}) }
  const cache =
    deps.cache ||
    cacheMod.createAudioCache({ dir: process.env.DJ_AUDIO_CACHE_DIR || cacheMod.defaultCacheDir() })
  const jobs = new Map() // segueId -> job
  const byKey = new Map() // `${sessionId}#${epoch}#${transitionId}` -> segueId
  const activeBySession = new Map() // sessionId -> segueId（仅 preparing）
  const gates = new Map() // sessionId -> { failures, cooldownUntil, blocked }
  const stats = { prepares: 0, cancels: 0, ready: 0, failed: 0, stale: 0, lateDiscards: 0 }

  const keyOf = (r) => `${r.sessionId}#${Number(r.epoch)}#${r.transitionId}`

  /** referenceIdOverride 供主动试听使用：候选音色还没保存成正式音色。 */
  function voiceConfig(referenceIdOverride) {
    const s = settings() || {}
    const model = s.fishModel || fishMod.FREE_MODEL
    // 测试钩子：注入模式下用哑配置通过预检，真实结果由 fish/dj-script 的注入模式决定
    if (process.env.RADIO_TEST_HOOKS === '1') {
      return fish.validateVoiceConfig({
        apiKey: getApiKey() || 'test-key',
        referenceId: referenceIdOverride || s.djVoiceReferenceId || 'test-voice',
        model,
      })
    }
    return fish.validateVoiceConfig({
      apiKey: getApiKey(),
      referenceId: referenceIdOverride || s.djVoiceReferenceId,
      model,
    })
  }

  function gate(sessionId) {
    if (!gates.has(sessionId)) gates.set(sessionId, { failures: 0, cooldownUntil: 0, blocked: null })
    return gates.get(sessionId)
  }

  /** 只读配置诊断：不调用供应商，密钥永不进入响应。 */
  function configuration() {
    const cfg = voiceConfig()
    let message = cfg.message || ''
    if (!cfg.ok && cfg.code === 'not_configured') {
      message = !getApiKey()
        ? '未配置 Fish 密钥：请在项目 .env 中设置 FISH_API_KEY，重启服务并刷新页面；之后选择音色试听。'
        : '尚未选择正式音色：停止收听后填写音色 reference_id，试听成功后点击「设为正式音色」。'
    }
    return { ready: cfg.ok, code: cfg.code || null, message, voiceReferenceId: (settings() || {}).djVoiceReferenceId || null }
  }

  function scheduleEviction(job) {
    if (job.evictTimer) clearTimer(job.evictTimer)
    // 保留期内 job() 惰性返回 expired；真正的内存清理延到两倍保留期
    job.evictTimer = setTimer(() => {
      jobs.delete(job.segueId)
      if (byKey.get(job.key) === job.segueId) byKey.delete(job.key)
      job.evictTimer = null
    }, limits.retentionMs * 2)
  }

  function jobView(job) {
    const v = {
      segueId: job.segueId,
      state: job.state,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      transition: { ...job.transition },
      reason: job.reason,
      message: job.message,
      code: job.code,
      deviations: job.deviations,
      script: job.script,
      audio: job.audio,
    }
    return v
  }

  /** 终态写入：绝不重新激活已离开 preparing 的任务。 */
  function finalize(job, patch) {
    if (job.state !== 'preparing') {
      stats.lateDiscards += 1
      return false
    }
    job.state = patch.state
    job.stage = null
    job.reason = patch.reason
    job.message = patch.message
    job.code = patch.code
    job.deviations = patch.deviations
    job.script = patch.script
    job.audio = patch.audio
    job.updatedAt = now()
    if (activeBySession.get(job.transition.sessionId) === job.segueId) activeBySession.delete(job.transition.sessionId)
    if (patch.state === 'ready') {
      stats.ready += 1
      const g = gate(job.transition.sessionId)
      g.failures = 0
      g.cooldownUntil = 0
      g.blocked = null
    } else if (patch.state === 'unavailable') {
      stats.failed += 1
      if (patch.code && CONFIG_BLOCK_CODES.includes(patch.code)) {
        gate(job.transition.sessionId).blocked = patch.code
      } else if (patch.reason !== 'cancelled') {
        const g = gate(job.transition.sessionId)
        g.failures += 1
        g.cooldownUntil = now() + Math.min(COOLDOWN_BASE_MS * 2 ** (g.failures - 1), COOLDOWN_MAX_MS)
      }
    } else if (patch.state === 'stale') {
      stats.stale += 1
    }
    scheduleEviction(job)
    return true
  }

  function fail(job, reason, { code, message } = {}) {
    return finalize(job, { state: 'unavailable', reason, code, message })
  }

  async function run(job, req) {
    const deadline = now() + limits.totalMs
    const remaining = () => Math.max(1, deadline - now())
    try {
      // 阶段 0：目标歌曲完整音源校验（准备开始时）
      const target = await resolveTarget(job.transition.targetTrackId)
      if (job.state !== 'preparing') return
      if (!target || target.kind !== 'full') {
        fail(job, 'target_unplayable', { message: '目标歌曲当前不可完整播放，撤销 DJ' })
        return
      }
      // 阶段 1：搜索与文案
      job.stage = 'research'
      job.updatedAt = now()
      const scriptRes = await djScript.generateSegueScript({
        targetTrackId: job.transition.targetTrackId,
        targetItemId: job.transition.targetItemId,
        transitionId: job.transition.transitionId,
        targetName: req.targetName || target.name || `曲目 ${job.transition.targetTrackId}`,
        targetArtists: req.targetArtists || target.artists || '',
        brief: req.brief || '',
        timeoutMs: Math.min(limits.scriptMs, remaining()),
      })
      if (job.state !== 'preparing') return
      if (!scriptRes.ok) {
        fail(job, 'script_failed', { code: scriptRes.code, message: scriptRes.message })
        return
      }
      job.script = scriptRes.script
      // 阶段 2：语音合成
      job.stage = 'synthesis'
      job.updatedAt = now()
      const cfg = voiceConfig()
      if (!cfg.ok) {
        fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
        return
      }
      const synth = await fish.synthesize({
        text: scriptRes.script.scriptText,
        apiKey: getApiKey(),
        referenceId: (settings() || {}).djVoiceReferenceId,
        model: (settings() || {}).fishModel || fishMod.FREE_MODEL,
        timeoutMs: Math.min(limits.ttsMs, remaining()),
      })
      if (job.state !== 'preparing') return
      if (!synth.ok) {
        const reason = synth.code === 'bad_audio' ? 'audio_invalid' : synth.code === 'too_long' ? 'audio_too_long' : 'synthesis_failed'
        fail(job, reason, { code: synth.code, message: synth.message })
        return
      }
      const dur = fish.evaluateAudioDuration(synth.durationMs)
      if (!dur.withinProgramLimit) {
        fail(job, 'audio_too_long', { message: '成品音频超过 30 秒，收窄文案后留给后续机会' })
        return
      }
      // 阶段 3：原子发布进缓存
      const put = await cache.put({
        text: scriptRes.script.scriptText,
        model: synth.model,
        referenceId: (settings() || {}).djVoiceReferenceId,
        buffer: synth.buffer,
        durationMs: synth.durationMs,
        contentType: synth.contentType,
      })
      if (job.state !== 'preparing') return
      if (!put.ok) {
        fail(job, 'synthesis_failed', { code: put.code, message: put.message })
        return
      }
      const deviations = []
      if (scriptRes.meta && scriptRes.meta.searchActivity) {
        deviations.push({ code: 'search_activity', searchEvents: scriptRes.meta.searchActivity.searchEvents })
      }
      const audioDeviations = []
      if (dur.deviation && scriptRes.script.storyStatus === 'basic_only') {
        audioDeviations.push({ code: dur.deviation, message: '基础介绍短于 15 秒，按契约降级使用', durationMs: synth.durationMs })
      }
      const candidate = {
        segueId: job.segueId,
        state: 'ready',
        createdAt: job.createdAt,
        transition: job.transition,
        script: scriptRes.script,
        audio: { assetId: put.assetId, url: `/api/dj/audio/${put.assetId}`, durationMs: synth.durationMs, bytes: put.bytes },
      }
      // 成品发布前按契约终检：跨目标/缺字段在这里挡下
      const v = contract.validateSegueJob(candidate)
      if (!v.ok) {
        fail(job, 'audio_invalid', { message: `成品未通过契约校验：${v.errors.map((e) => e.code).join(',')}` })
        return
      }
      finalize(job, { state: 'ready', deviations: [...audioDeviations, ...deviations], script: candidate.script, audio: candidate.audio })
    } catch (err) {
      fail(job, 'script_failed', { code: 'error', message: String((err && err.message) || err) })
    }
  }

  /**
   * 提交准备。返回 { ok:true, job }（preparing）或 { ok:false, code, message }。
   * 复用：同一机会键且 payload 一致；冲突：同键不同 payload；冷却/阻塞：明确拒绝。
   */
  async function prepare(req) {
    const v = contract.validatePrepareRequest(req)
    if (!v.ok) {
      return { ok: false, code: 'invalid_request', message: v.errors.map((e) => `${e.path}:${e.code}`).join(',') }
    }
    const reqNorm = v.value
    const key = keyOf(reqNorm)
    stats.prepares += 1

    // 同键复用/冲突
    const existingId = byKey.get(key)
    if (existingId) {
      const existing = jobs.get(existingId)
      if (existing && existing.state !== 'stale') {
        const match = contract.jobMatchesPrepare(existing, reqNorm)
        if (match.match) return { ok: true, job: jobView(existing), reused: true }
        return { ok: false, code: 'payload_conflict', message: '同一机会的不同内容，不能复用同一任务' }
      }
    }

    // 会话级冷却/阻塞
    const g = gate(reqNorm.sessionId)
    if (g.blocked) return { ok: false, code: `${g.blocked}_blocked`, message: '语音配置/认证错误，配置更新前不再重复请求' }
    if (now() < g.cooldownUntil) return { ok: false, code: 'cooldown_active', message: '连续失败后的有界冷却中，稍后再试' }

    // 会话级语音配置预检：缺配置直接失败，不消耗 Codex 额度
    const cfg = voiceConfig()
    if (!cfg.ok) {
      const job = newJob(reqNorm)
      jobs.set(job.segueId, job)
      byKey.set(key, job.segueId)
      fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
      return { ok: true, job: jobView(job) }
    }

    // 同一会话最多一条有效流水线
    const activeId = activeBySession.get(reqNorm.sessionId)
    if (activeId) {
      const active = jobs.get(activeId)
      if (active && active.state === 'preparing') {
        active.state = 'stale'
        active.reason = 'superseded'
        active.updatedAt = now()
        stats.stale += 1
        scheduleEviction(active)
      }
      activeBySession.delete(reqNorm.sessionId)
    }

    const job = newJob(reqNorm)
    jobs.set(job.segueId, job)
    byKey.set(key, job.segueId)
    activeBySession.set(reqNorm.sessionId, job.segueId)
    run(job, reqNorm) // 异步推进；返回不必等它
    return { ok: true, job: jobView(job) }
  }

  function newJob(reqNorm) {
    return {
      segueId: contract.makeId('sg'),
      state: 'preparing',
      stage: 'research',
      createdAt: now(),
      updatedAt: now(),
      key: keyOf(reqNorm),
      transition: {
        sessionId: reqNorm.sessionId,
        epoch: reqNorm.epoch,
        transitionId: reqNorm.transitionId,
        fromItemId: reqNorm.fromItemId,
        targetItemId: reqNorm.targetItemId,
        targetTrackId: reqNorm.targetTrackId,
        state: 'open',
      },
      script: null,
      audio: null,
      reason: null,
      message: null,
      code: null,
      deviations: null,
      evictTimer: null,
    }
  }

  /** 查询任务；过期/未知按 not_found/expired 处理。 */
  function job(segueId) {
    const job = jobs.get(String(segueId || ''))
    if (!job) return { ok: false, code: 'not_found', message: '任务不存在或已被清理' }
    if (job.state === 'ready' || job.state === 'unavailable' || job.state === 'stale') {
      if (now() - job.updatedAt > limits.retentionMs) {
        return { ok: false, code: 'expired', message: '任务已完成并超过保留期' }
      }
    }
    return { ok: true, job: jobView(job) }
  }

  /** 幂等取消：排程资格作废，不影响歌曲或其他机会。 */
  async function cancel(segueId) {
    const job = jobs.get(String(segueId || ''))
    if (!job) return { ok: true, cancelled: false }
    if (job.state === 'preparing') {
      finalize(job, { state: 'unavailable', reason: 'cancelled', message: '机会已关闭，准备任务取消' })
      stats.cancels += 1
      return { ok: true, cancelled: true }
    }
    return { ok: true, cancelled: false }
  }

  /** 会话停止：该会话全部任务失效。 */
  function invalidateSession(sessionId) {
    for (const job of jobs.values()) {
      if (job.transition.sessionId === sessionId && job.state === 'preparing') {
        finalize(job, { state: 'stale', reason: 'session_ended', message: '收听会话已停止' })
      }
    }
    gates.delete(sessionId)
  }

  /** 配置更新：解除配置/认证类阻塞。 */
  function voiceConfigChanged() {
    for (const g of gates.values()) {
      g.blocked = null
      g.failures = 0
      g.cooldownUntil = 0
    }
    return { ok: true }
  }

  /** 主动试听：固定短稿 + 指定音色；不创建节目任务、不写入歌曲历史。 */
  async function preview({ referenceId, text } = {}) {
    const cfg = voiceConfig(referenceId)
    if (!cfg.ok) return { ok: false, code: cfg.code, message: cfg.message }
    const previewText = typeof text === 'string' && text.trim() ? text : PREVIEW_TEXT
    // 相同音色+文案复用缓存，不重复请求供应商
    const reuseId = cache.computeAssetId({ text: previewText, model: cfg.model, referenceId, voiceParams: {} })
    const hit = cache.getMeta(reuseId)
    if (hit.hit) {
      return { ok: true, audio: { assetId: hit.assetId, url: `/api/dj/audio/${hit.assetId}`, durationMs: hit.durationMs, bytes: hit.bytes } }
    }
    const synth = await fish.synthesize({
      text: previewText,
      apiKey: getApiKey(),
      referenceId,
      model: cfg.model,
      timeoutMs: limits.ttsMs,
    })
    if (!synth.ok) return { ok: false, code: synth.code, message: synth.message }
    const put = await cache.put({
      text: previewText,
      model: synth.model,
      referenceId,
      buffer: synth.buffer,
      durationMs: synth.durationMs,
      contentType: synth.contentType,
    })
    if (!put.ok) return { ok: false, code: put.code === 'cache_full' ? 'cache_full' : 'error', message: put.message }
    return {
      ok: true,
      audio: { assetId: put.assetId, url: `/api/dj/audio/${put.assetId}`, durationMs: synth.durationMs, bytes: put.bytes },
    }
  }

  return {
    configuration,
    prepare,
    job,
    cancel,
    invalidateSession,
    voiceConfigChanged,
    preview,
    assetPath: (assetId) => cache.pathFor(assetId),
    cacheStats: () => cache.stats(),
    stats: () => ({ ...stats, active: activeBySession.size }),
    /** 测试钩子：清空全部计时器，防止进程挂起。 */
    _dispose() {
      for (const job of jobs.values()) if (job.evictTimer) clearTimer(job.evictTimer)
    },
  }
}

module.exports = { createDjPipeline, LIMITS, PREVIEW_TEXT }
