import { createRequestGate, type SessionOrder } from './request-order'
import * as contract from '@radio/contracts'
import * as fishMod from './fish.service'
import { FishService } from './fish.service'
import { createAudioCache, AudioCache } from './audio-cache'
import { DjScriptService, type SegueScriptInput } from './dj-script.service'
import { NeteaseService } from '../music/netease.service'
import { type SseMessage } from '../events/events.service'
import { FISH, DJ as DJ_CONFIG, DJ_AUDIO_CACHE_DIR } from '../config/app-config'

import { createPreparationRunner } from './pipeline-steps'
import { createJobStore, type Job } from './pipeline-jobs'
const LIMITS = {
  scriptMs: DJ_CONFIG.scriptTimeoutMs,
  ttsMs: FISH.ttsTimeoutMs,
  totalMs: DJ_CONFIG.totalMs,
  retentionMs: DJ_CONFIG.retentionMs,
}

// 工厂默认依赖：Nest 类会在构造时传入真实实例；直接调用工厂（测试）时用这些惰性单例
let cacheInstanceRef: AudioCache | null = null
function ensureCache(): AudioCache {
  if (!cacheInstanceRef) cacheInstanceRef = createAudioCache({ dir: DJ_AUDIO_CACHE_DIR })
  return cacheInstanceRef
}

/** djScript 缺省实现（与旧版默认 djScriptMod 等价）：惰性构造服务实例。 */
const defaultDjScript = {
  generateSegueScript: (input: SegueScriptInput) => new DjScriptService().generateSegueScript(input),
}
const PREVIEW_TEXT = '你好，这是一段音色试听。接下来的歌，讲一个它的故事。'
export { PREVIEW_TEXT }

export interface DjPipelineDeps {
  sessions?: SessionOrder
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

  const store = createJobStore({ now, setTimer, clearTimer, retentionMs: limits.retentionMs, onStatus: deps.onStatus })
  const { finalize, fail, newJob, jobView, gate } = store
  const requests = createRequestGate(deps.sessions)
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

  function isCurrent(job: Job, req: contract.PrepareRequest): boolean {
    if (job.state !== 'preparing') return false
    if (requests.isCurrent(req)) return true
    finalize(job, { state: 'stale', reason: 'session_ended', message: '会话或准备顺序已失效' })
    return false
  }

  const run = createPreparationRunner({ now, limits, resolveTarget, djScript, fish, voiceConfig,
    getApiKey, settings, cache, isCurrent, fail, finalize })

  async function prepare(req: unknown) {
    const v = contract.validatePrepareRequest(req)
    if (!v.ok) {
      return { ok: false, code: 'invalid_request', message: v.errors.map((e) => `${e.path}:${e.code}`).join(',') }
    }
    const reqNorm = v.value!
    const accepted = requests.accept(reqNorm)
    if (!accepted.ok) return accepted
    store.countPrepare()

    const existing = store.getByRequest(reqNorm)
    if (existing && existing.state !== 'stale') {
      const match = contract.jobMatchesPrepare(existing, reqNorm)
      if (match.match) return { ok: true, job: jobView(existing), reused: true }
      return { ok: false, code: 'payload_conflict', message: '同一机会的不同内容，不能复用同一任务' }
    }

    const g = gate(reqNorm.sessionId)
    if (g.blocked) return { ok: false, code: `${g.blocked}_blocked`, message: '语音配置/认证错误，配置更新前不再重复请求' }
    if (now() < g.cooldownUntil) return { ok: false, code: 'cooldown_active', message: '连续失败后的有界冷却中，稍后再试' }

    const cfg = voiceConfig()
    if (!cfg.ok) {
      const job = newJob(reqNorm)
      fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
      return { ok: true, job: jobView(job) }
    }

    store.supersede(reqNorm.sessionId)

    const job = newJob(reqNorm)
    void run(job, reqNorm)
    return { ok: true, job: jobView(job) }
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
    job: store.job,
    cancel: store.cancel,
    invalidateSession(sessionId: string) { requests.close(sessionId); store.invalidateSession(sessionId) },
    voiceConfigChanged: store.voiceConfigChanged,
    preview,
    assetPath: (assetId: string) => cache.pathFor(assetId),
    cacheStats: () => cache.stats(),
    stats: store.stats,
    _dispose: store.dispose,
  }
}
