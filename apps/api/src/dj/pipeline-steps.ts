import * as contract from '@radio/contracts'
import * as fishMod from './fish.service'
import type { DjPipelineDeps } from './pipeline'
import type { Job } from './pipeline-jobs'

type Patch = Partial<Pick<Job, 'reason' | 'code' | 'message' | 'deviations' | 'script' | 'audio'>> & { state: contract.JobState }
interface PreparationContext {
  now: () => number
  limits: { totalMs: number; scriptMs: number; ttsMs: number }
  resolveTarget: NonNullable<DjPipelineDeps['resolveTarget']>
  djScript: NonNullable<DjPipelineDeps['djScript']>
  fish: NonNullable<DjPipelineDeps['fish']>
  voiceConfig: () => ReturnType<typeof fishMod.validateVoiceConfig>
  getApiKey: () => string | null
  settings: () => Record<string, string>
  cache: NonNullable<DjPipelineDeps['cache']>
  isCurrent: (job: Job, request: contract.PrepareRequest) => boolean
  fail: (job: Job, reason: string, detail?: { code?: string; message?: string }) => boolean
  finalize: (job: Job, patch: Patch) => boolean
}
type Synth = Extract<Awaited<ReturnType<PreparationContext['fish']['synthesize']>>, { ok: true }>
interface Researched { script: contract.SegueScript; searchEvents?: number }

/** Each await is followed by the single owner’s validity check before the next stage. */
export function createPreparationRunner(context: PreparationContext) {
  return async (job: Job, req: contract.PrepareRequest) => {
    const deadline = context.now() + context.limits.totalMs
    const remaining = () => Math.max(1, deadline - context.now())
    try {
      if (!context.isCurrent(job, req)) return
      const researched = await research(context, job, req, remaining)
      if (!researched) return
      const synth = await synthesize(context, job, req, researched.script, remaining)
      if (!synth) return
      await publish(context, job, req, researched, synth)
    } catch (error) {
      if (!context.isCurrent(job, req)) return
      context.fail(job, 'script_failed', { code: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
}

async function research(c: PreparationContext, job: Job, req: contract.PrepareRequest, remaining: () => number): Promise<Researched | null> {
  const target = await c.resolveTarget(req.targetTrackId)
  if (!c.isCurrent(job, req)) return null
  if (target.kind !== 'full') {
    c.fail(job, 'target_unplayable', { message: '目标歌曲当前不可完整播放，撤销 DJ' })
    return null
  }
  job.stage = 'research'
  job.updatedAt = c.now()
  const response = await c.djScript.generateSegueScript(scriptInput(req, target, Math.min(c.limits.scriptMs, remaining())))
  if (!c.isCurrent(job, req)) return null
  if (!response.ok) {
    c.fail(job, 'script_failed', { code: typeof response.code === 'string' ? response.code : 'error', message: typeof response.message === 'string' ? response.message : '' })
    return null
  }
  const validated = contract.validateScript(response.script, req)
  if (!validated.ok) {
    c.fail(job, 'script_failed', { code: 'invalid_output', message: validated.errors.map(e => e.code).join(',') })
    return null
  }
  job.script = validated.value!
  return { script: validated.value!, searchEvents: searchEvents(response.meta) }
}

function searchEvents(meta: unknown): number | undefined {
  if (!meta || typeof meta !== 'object' || !('searchActivity' in meta)) return undefined
  const activity = meta.searchActivity
  if (!activity || typeof activity !== 'object' || !('searchEvents' in activity)) return undefined
  return typeof activity.searchEvents === 'number' ? activity.searchEvents : undefined
}

function synthesisFailureReason(code: string): string {
  if (code === 'bad_audio') return 'audio_invalid'
  if (code === 'too_long') return 'audio_too_long'
  return 'synthesis_failed'
}

async function synthesize(c: PreparationContext, job: Job, req: contract.PrepareRequest, script: contract.SegueScript, remaining: () => number): Promise<Synth | null> {
  if (!c.isCurrent(job, req)) return null
  job.stage = 'synthesis'
  job.updatedAt = c.now()
  const cfg = c.voiceConfig()
  if (!cfg.ok) {
    c.fail(job, 'voice_not_configured', { code: cfg.code, message: cfg.message })
    return null
  }
  const result = await c.fish.synthesize({
    text: script.scriptText, apiKey: c.getApiKey() || undefined,
    referenceId: c.settings().djVoiceReferenceId || undefined,
    model: c.settings().fishModel || fishMod.FREE_MODEL,
    timeoutMs: Math.min(c.limits.ttsMs, remaining()),
  })
  if (!c.isCurrent(job, req)) return null
  if (!result.ok) {
    c.fail(job, synthesisFailureReason(result.code), { code: result.code, message: result.message })
    return null
  }
  if (!c.fish.evaluateAudioDuration(result.durationMs).withinProgramLimit) {
    c.fail(job, 'audio_too_long', { message: '成品音频超过 30 秒，收窄文案后留给后续机会' })
    return null
  }
  return result
}

async function publish(c: PreparationContext, job: Job, req: contract.PrepareRequest, researched: Researched, synth: Synth): Promise<void> {
  if (!c.isCurrent(job, req)) return
  const put = await c.cache.put({
    text: researched.script.scriptText, model: synth.model, referenceId: c.settings().djVoiceReferenceId,
    buffer: synth.buffer, durationMs: synth.durationMs, contentType: synth.contentType,
  })
  if (!c.isCurrent(job, req)) return
  if (!put.ok) {
    c.fail(job, 'synthesis_failed', { code: put.code, message: put.message })
    return
  }
  const audio = { assetId: put.assetId!, url: `/api/dj/audio/${put.assetId}`, durationMs: synth.durationMs, bytes: put.bytes! }
  const candidate = { segueId: job.segueId, state: 'ready', createdAt: job.createdAt, transition: job.transition, script: researched.script, audio }
  const validated = contract.validateSegueJob(candidate)
  if (!validated.ok) {
    c.fail(job, 'audio_invalid', { message: `成品未通过契约校验：${validated.errors.map(e => e.code).join(',')}` })
    return
  }
  const deviations: Array<{ code: string; [key: string]: unknown }> = []
  const duration = c.fish.evaluateAudioDuration(synth.durationMs)
  if (duration.deviation && researched.script.storyStatus === 'basic_only') deviations.push({ code: duration.deviation, message: '基础介绍短于 15 秒，按契约降级使用', durationMs: synth.durationMs })
  if (researched.searchEvents !== undefined) deviations.push({ code: 'search_activity', searchEvents: researched.searchEvents })
  c.finalize(job, { state: 'ready', script: researched.script, audio, deviations })
}

function scriptInput(req: contract.PrepareRequest, target: Awaited<ReturnType<PreparationContext['resolveTarget']>>, timeoutMs: number) {
  return {
    targetTrackId: req.targetTrackId, targetItemId: req.targetItemId, transitionId: req.transitionId,
    targetName: req.targetName || target.name || `曲目 ${req.targetTrackId}`,
    targetArtists: req.targetArtists || target.artists || '', brief: req.brief || '', timeoutMs,
  }
}
