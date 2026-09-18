/**
 * DJ 准备流水线（迁移自 server/dj-pipeline.js）：把「目标音源校验 → 搜索文案 →
 * 语音合成 → 缓存发布」串成一条有限时间的任务，并以进程内状态对外提供查询/取消/试听。
 *
 * 约束：
 *  - 同一个 (sessionId, epoch, transitionId) 的重复提交复用任务；同键不同 payload 拒绝。
 *  - 同一会话最多一条有效流水线；新机会自动把旧机会作废（stale/superseded）。
 *  - 总截止 150 秒、文案 90 秒、合成 60 秒；取消/过期结果不重新激活任务。
 *  - 临时失败 60s 倍增至 15min 有界冷却；配置/认证类失败阻塞到配置更新。
 *  - 没有免费语音配置时提前返回 voice_not_configured，不消耗 Codex 额度。
 *  - ready 成品经 program-contract 校验，携带完整媒体/目标身份与版本。
 */
import { Injectable } from '@nestjs/common'
import * as contract from '@radio/contracts'
import * as fishMod from './fish.service'
import { FishService } from './fish.service'
import { createAudioCache, AudioCache } from './audio-cache'
import { DjScriptService, type SegueScriptInput } from './dj-script.service'
import { NeteaseService } from '../music/netease.service'
import { DbService } from '../persistence/db.service'
import { EventsService, type SseMessage } from '../events/events.service'
import { FISH, DJ as DJ_CONFIG, DJ_AUDIO_CACHE_DIR } from '../config/app-config'

const LIMITS = {
  scriptMs: DJ_CONFIG.scriptTimeoutMs,
  ttsMs: FISH.ttsTimeoutMs,
  totalMs: DJ_CONFIG.totalMs,
  retentionMs: DJ_CONFIG.retentionMs,
}
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
const CONFIG_BLOCK_CODES = ['not_configured', 'auth', 'unknown_model', 'invalid_reference']

// 工厂默认依赖：Nest 类会在构造时传入真实实例；直接调用工厂（测试）时用这些惰性单例
let cacheInstanceRef: AudioCache | null = null
function ensureCache(): AudioCache {
  if (!cacheInstanceRef) cacheInstanceRef = createAudioCache({ dir: DJ_AUDIO_CACHE_DIR })
  return cacheInstanceRef
}

/** djScript 缺省实现（与旧版默认 djScriptMod 等价）：惰性构造服务实例。 */
let defaultDjScriptRef: { generateSegueScript: (input: SegueScriptInput) => Promise<Record<string, unknown>> } | null = null
const defaultDjScript = new Proxy({} as { generateSegueScript: (input: SegueScriptInput) => Promise<Record<string, unknown>> }, {
  get(_, prop) {
    if (!defaultDjScriptRef) defaultDjScriptRef = new DjScriptService()
    return (defaultDjScriptRef as unknown as Record<string | symbol, unknown>)[prop]
  },
})
const PREVIEW_TEXT = '你好，这是一段音色试听。接下来的歌，讲一个它的故事。'
export { PREVIEW_TEXT }

interface Job {
  segueId: string
  state: contract.JobState
  stage: contract.JobStage | null
  createdAt: number
  updatedAt: number
  key: string
  transition: contract.Transition
  script: contract.SegueScript | null
  audio: { assetId: string; url: string; durationMs: number; bytes: number } | null
  reason: string | null
  message: string | null
  code: string | null
  deviations: Array<{ code: string; [k: string]: unknown }> | null
  evictTimer: unknown | null
}

@Injectable()
export class DjPipelineService {
  private pipeline: ReturnType<typeof createDjPipeline>

  constructor(fish: FishService, djScript: DjScriptService, ncm: NeteaseService, db: DbService, private readonly events: EventsService) {
    this.fish = fish
    this.djScript = djScript
    this.ncm = ncm
    this.db = db
    this.cache = createAudioCache({ dir: DJ_AUDIO_CACHE_DIR })
    this.pipeline = createDjPipeline({
      onStatus: (msg) => events.publish(msg),
      settings: () => db.listSettings(),
      getApiKey: () => FISH.apiKey(),
      resolveTarget: async (trackId: number) => {
        try {
          return await ncm.resolveTrack(trackId)
        } catch (err) {
          return { kind: 'unplayable', message: (err as Error).message }
        }
      },
      djScript: djScript,
      fish: fish,
      cache: this.cache,
    })
  }

  private fish: FishService
  private djScript: DjScriptService
  private ncm: NeteaseService
  private db: DbService
  private cache: AudioCache

  configuration(): { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null } {
    return this.pipeline.configuration()
  }

  async prepare(req: unknown): Promise<Record<string, unknown>> {
    const r = await this.pipeline.prepare(req)
    return r
  }

  job(segueId: string): { ok: boolean; code?: string; message?: string; job?: Record<string, unknown> } {
    return this.pipeline.job(segueId)
  }

  async cancel(segueId: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return this.pipeline.cancel(segueId)
  }

  invalidateSession(sessionId: string): void {
    return this.pipeline.invalidateSession(sessionId)
  }

  voiceConfigChanged(): { ok: true } {
    return this.pipeline.voiceConfigChanged()
  }

  async preview(input: { referenceId?: string; text?: string } = {}): Promise<Record<string, unknown>> {
    return this.pipeline.preview(input)
  }

  assetPath(assetId: string): string | null {
    return this.pipeline.assetPath(assetId)
  }

  cacheStats(): ReturnType<AudioCache['stats']> {
    return this.pipeline.cacheStats()
  }

  pipelineStats(): Record<string, unknown> {
    return this.pipeline.stats()
  }

  _dispose(): void {
    this.pipeline._dispose()
  }
}

/* ---------- 可注入工厂（行为合同与旧 server/dj-pipeline.js 相同，测试直接使用） ---------- */

export interface DjPipelineDeps {
  onStatus?: (msg: SseMessage) => void
  settings?: () => Record<string, string>
  getApiKey?: () => string | null
  djScript?: { generateSegueScript: (input: SegueScriptInput) => Promise<Record<string, unknown>> }
  fish?: {
    synthesize: FishService['synthesize']
    evaluateAudioDuration: FishService['evaluateAudioDuration']
    validateVoiceConfig: typeof fishMod.validateVoiceConfig
  }
  cache?: AudioCache
  resolveTarget?: (trackId: number) => Promise<{ kind: string; name?: string; artists?: string; message?: string }>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  limits?: Partial<typeof LIMITS>
}

export function createDjPipeline(deps: DjPipelineDeps = {}) {
  const settings = deps.settings || ((): Record<string, string> => ({}))
  const getApiKey = deps.getApiKey || (() => FISH.apiKey())
  if (!deps.fish) {
    throw new TypeError('createDjPipeline: 必须注入 fish 实现（生产由 Nest 提供，测试用替身）')
  }
  const djScript = deps.djScript || defaultDjScript
  const fish = deps.fish
  const resolveTarget = deps.resolveTarget || (async () => ({ kind: 'full' }))
  const now = deps.now || (() => Date.now())
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t as NodeJS.Timeout))
  const limits = { ...LIMITS, ...(deps.limits || {}) }
  const cache = deps.cache || ensureCache()

  const jobs = new Map<string, Job>()
  const byKey = new Map<string, string>()
  const activeBySession = new Map<string, string>()
  const gates = new Map<string, { failures: number; cooldownUntil: number; blocked: string | null }>()
  const stats = { prepares: 0, cancels: 0, ready: 0, failed: 0, stale: 0, lateDiscards: 0 }

  const keyOf = (r: { sessionId: string; epoch: number; transitionId: string }) => `${r.sessionId}#${Number(r.epoch)}#${r.transitionId}`

  function voiceConfig(referenceIdOverride?: string) {
    const s = settings() || {}
    const model = s.fishModel || fishMod.FREE_MODEL
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

  function gate(sessionId: string) {
    if (!gates.has(sessionId)) gates.set(sessionId, { failures: 0, cooldownUntil: 0, blocked: null })
    return gates.get(sessionId)!
  }

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

  function scheduleEviction(job: Job) {
    if (job.evictTimer) clearTimer(job.evictTimer)
    job.evictTimer = setTimer(() => {
      jobs.delete(job.segueId)
      if (byKey.get(job.key) === job.segueId) byKey.delete(job.key)
      job.evictTimer = null
    }, limits.retentionMs * 2)
  }

  function jobView(job: Job) {
    return {
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
  }

  function finalize(job: Job, patch: { state: contract.JobState; reason?: string | null; message?: string | null; code?: string | null; deviations?: Array<{ code: string; [k: string]: unknown }> | null; script?: contract.SegueScript | null; audio?: { assetId: string; url: string; durationMs: number; bytes: number } | null }) {
    if (job.state !== 'preparing') {
      stats.lateDiscards += 1
      return false
    }
    job.state = patch.state
    job.stage = null
    job.reason = patch.reason ?? null
    job.message = patch.message ?? null
    job.code = patch.code ?? null
    job.deviations = patch.deviations ?? null
    job.script = patch.script ?? null
    job.audio = patch.audio ?? null
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
    deps.onStatus?.({ type: 'dj-status', sessionId: job.transition.sessionId, epoch: job.transition.epoch, transitionId: job.transition.transitionId, segueId: job.segueId, state: job.state, code: job.code ?? undefined })
    return true
  }

  function fail(job: Job, reason: string, { code, message }: { code?: string; message?: string } = {}) {
    return finalize(job, { state: 'unavailable', reason, code, message })
  }

  async function run(job: Job, req: contract.PrepareRequest) {
    const deadline = now() + limits.totalMs
    const remaining = () => Math.max(1, deadline - now())
    try {
      const target = (await resolveTarget(job.transition.targetTrackId!)) as { kind: string; name?: string; artists?: string; message?: string }
      if (job.state !== 'preparing') return
      if (!target || target.kind !== 'full') {
        fail(job, 'target_unplayable', { message: '目标歌曲当前不可完整播放，撤销 DJ' })
        return
      }
      job.stage = 'research'
      job.updatedAt = now()
      const scriptRes = (await djScript.generateSegueScript({
        targetTrackId: job.transition.targetTrackId!,
        targetItemId: job.transition.targetItemId,
        transitionId: job.transition.transitionId,
        targetName: req.targetName || target.name || `曲目 ${job.transition.targetTrackId}`,
        targetArtists: req.targetArtists || target.artists || '',
        brief: req.brief || '',
        timeoutMs: Math.min(limits.scriptMs, remaining()),
      })) as { ok: boolean; script?: contract.SegueScript; code?: string; message?: string; meta?: { searchActivity?: { searchEvents: number } } }
      if (job.state !== 'preparing') return
      if (!scriptRes.ok) {
        fail(job, 'script_failed', { code: scriptRes.code, message: scriptRes.message })
        return
      }
      job.script = scriptRes.script!
      job.stage = 'synthesis'
      job.updatedAt = now()
      const cfg = voiceConfig()
      if (!cfg.ok) {
        fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
        return
      }
      const synth = await fish.synthesize({
        text: scriptRes.script!.scriptText,
        apiKey: getApiKey() || undefined,
        referenceId: settings().djVoiceReferenceId || undefined,
        model: settings().fishModel || fishMod.FREE_MODEL,
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
      const put = await cache.put({
        text: scriptRes.script!.scriptText,
        model: synth.model,
        referenceId: settings().djVoiceReferenceId,
        buffer: synth.buffer,
        durationMs: synth.durationMs,
        contentType: synth.contentType,
      })
      if (job.state !== 'preparing') return
      if (!put.ok) {
        fail(job, 'synthesis_failed', { code: put.code, message: put.message })
        return
      }
      const deviations: Array<{ code: string; [k: string]: unknown }> = []
      if (scriptRes.meta && scriptRes.meta.searchActivity) {
        deviations.push({ code: 'search_activity', searchEvents: scriptRes.meta.searchActivity.searchEvents })
      }
      const audioDeviations: Array<{ code: string; [k: string]: unknown }> = []
      if (dur.deviation && scriptRes.script!.storyStatus === 'basic_only') {
        audioDeviations.push({ code: dur.deviation, message: '基础介绍短于 15 秒，按契约降级使用', durationMs: synth.durationMs })
      }
      const candidate = {
        segueId: job.segueId,
        state: 'ready',
        createdAt: job.createdAt,
        transition: job.transition,
        script: scriptRes.script!,
        audio: { assetId: put.assetId!, url: `/api/dj/audio/${put.assetId}`, durationMs: synth.durationMs, bytes: put.bytes! },
      }
      const v = contract.validateSegueJob(candidate)
      if (!v.ok) {
        fail(job, 'audio_invalid', { message: `成品未通过契约校验：${v.errors.map((e) => e.code).join(',')}` })
        return
      }
      finalize(job, {
        state: 'ready',
        deviations: [...audioDeviations, ...deviations],
        script: candidate.script,
        audio: candidate.audio,
      })
    } catch (err) {
      fail(job, 'script_failed', { code: 'error', message: String((err as Error).message || err) })
    }
  }

  function newJob(reqNorm: contract.PrepareRequest): Job {
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
        createdAt: now(),
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

  async function prepare(req: unknown) {
    const v = contract.validatePrepareRequest(req)
    if (!v.ok) {
      return { ok: false, code: 'invalid_request', message: v.errors.map((e) => `${e.path}:${e.code}`).join(',') }
    }
    const reqNorm = v.value!
    const key = keyOf(reqNorm)
    stats.prepares += 1

    const existingId = byKey.get(key)
    if (existingId) {
      const existing = jobs.get(existingId)
      if (existing && existing.state !== 'stale') {
        const match = contract.jobMatchesPrepare(existing, reqNorm)
        if (match.match) return { ok: true, job: jobView(existing), reused: true }
        return { ok: false, code: 'payload_conflict', message: '同一机会的不同内容，不能复用同一任务' }
      }
    }

    const g = gate(reqNorm.sessionId)
    if (g.blocked) return { ok: false, code: `${g.blocked}_blocked`, message: '语音配置/认证错误，配置更新前不再重复请求' }
    if (now() < g.cooldownUntil) return { ok: false, code: 'cooldown_active', message: '连续失败后的有界冷却中，稍后再试' }

    const cfg = voiceConfig()
    if (!cfg.ok) {
      const job = newJob(reqNorm)
      jobs.set(job.segueId, job)
      byKey.set(key, job.segueId)
      fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
      return { ok: true, job: jobView(job) }
    }

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
    void run(job, reqNorm)
    return { ok: true, job: jobView(job) }
  }

  function job(segueId: string) {
    const j = jobs.get(String(segueId || ''))
    if (!j) return { ok: false, code: 'not_found', message: '任务不存在或已被清理' }
    if (j.state === 'ready' || j.state === 'unavailable' || j.state === 'stale') {
      if (now() - j.updatedAt > limits.retentionMs) {
        return { ok: false, code: 'expired', message: '任务已完成并超过保留期' }
      }
    }
    return { ok: true, job: jobView(j) }
  }

  async function cancel(segueId: string) {
    const j = jobs.get(String(segueId || ''))
    if (!j) return { ok: true, cancelled: false }
    if (j.state === 'preparing') {
      finalize(j, { state: 'unavailable', reason: 'cancelled', message: '机会已关闭，准备任务取消' })
      stats.cancels += 1
      return { ok: true, cancelled: true }
    }
    return { ok: true, cancelled: false }
  }

  function invalidateSession(sessionId: string) {
    for (const j of jobs.values()) {
      if (j.transition.sessionId === sessionId && j.state === 'preparing') {
        finalize(j, { state: 'stale', reason: 'session_ended', message: '收听会话已停止' })
      }
    }
    gates.delete(sessionId)
  }

  function voiceConfigChanged(): { ok: true } {
    for (const g of gates.values()) {
      g.blocked = null
      g.failures = 0
      g.cooldownUntil = 0
    }
    return { ok: true }
  }

  async function preview({ referenceId, text }: { referenceId?: string; text?: string } = {}) {
    const cfg = voiceConfig(referenceId)
    if (!cfg.ok) return { ok: false, code: cfg.code, message: cfg.message }
    const previewText = typeof text === 'string' && text.trim() ? text : PREVIEW_TEXT
    const reuseId = cache.computeAssetId({ text: previewText, model: cfg.model!, referenceId, voiceParams: {} })
    const hit = cache.getMeta(reuseId)
    if (hit.hit) {
      return { ok: true, audio: { assetId: reuseId, url: `/api/dj/audio/${reuseId}`, durationMs: hit.durationMs, bytes: hit.bytes } }
    }
    const synth = await fish.synthesize({
      text: previewText,
      apiKey: getApiKey() || undefined,
      referenceId,
      model: cfg.model!,
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
    assetPath: (assetId: string) => cache.pathFor(assetId),
    cacheStats: () => cache.stats(),
    stats: () => ({ ...stats, active: activeBySession.size }),
    _dispose() {
      for (const j of jobs.values()) if (j.evictTimer) clearTimer(j.evictTimer)
    },
  }
}
