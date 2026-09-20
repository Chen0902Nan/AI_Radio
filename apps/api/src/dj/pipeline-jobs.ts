import * as contract from '@radio/contracts'

export interface Job {
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


import type { DjPipelineDeps } from './pipeline'
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
const CONFIG_BLOCK_CODES = ['not_configured', 'auth', 'unknown_model', 'invalid_reference']

export function createJobStore(deps: Pick<DjPipelineDeps, 'onStatus'> & {
  now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (timer: unknown) => void; retentionMs: number
}) {
  const { now, setTimer, clearTimer } = deps
  const limits = { retentionMs: deps.retentionMs }
  const jobs = new Map<string, Job>()
  const byKey = new Map<string, string>()
  const activeBySession = new Map<string, string>()
  const gates = new Map<string, { failures: number; cooldownUntil: number; blocked: string | null }>()
  const stats = { prepares: 0, cancels: 0, ready: 0, failed: 0, stale: 0, lateDiscards: 0 }

  const keyOf = (r: { sessionId: string; epoch: number; transitionId: string }) => `${r.sessionId}#${Number(r.epoch)}#${r.transitionId}`

  function gate(sessionId: string) {
    if (!gates.has(sessionId)) gates.set(sessionId, { failures: 0, cooldownUntil: 0, blocked: null })
    return gates.get(sessionId)!
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
    recordOutcome(job, patch)
    scheduleEviction(job)
    deps.onStatus?.({ type: 'dj-status', sessionId: job.transition.sessionId, epoch: job.transition.epoch, transitionId: job.transition.transitionId, segueId: job.segueId, state: job.state, code: job.code ?? undefined })
    return true
  }

  function recordOutcome(job: Job, patch: Parameters<typeof finalize>[1]) {
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
  }

  function fail(job: Job, reason: string, { code, message }: { code?: string; message?: string } = {}) {
    return finalize(job, { state: 'unavailable', reason, code, message })
  }

  function newJob(reqNorm: contract.PrepareRequest): Job {
    const job: Job = {
      segueId: contract.makeId('sg'),
      state: 'preparing',
      stage: 'research',
      createdAt: now(),
      updatedAt: now(),
      key: keyOf(reqNorm),
      transition: {
        sessionId: reqNorm.sessionId,
        epoch: reqNorm.epoch,
        transitionSeq: reqNorm.transitionSeq,
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
    jobs.set(job.segueId, job)
    byKey.set(job.key, job.segueId)
    activeBySession.set(reqNorm.sessionId, job.segueId)
    return job
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


  function supersede(sessionId: string) {
    const id = activeBySession.get(sessionId)
    const active = id ? jobs.get(id) : undefined
    if (active?.state === 'preparing') finalize(active, { state: 'stale', reason: 'superseded' })
  }
  return {
    finalize, fail, newJob, jobView, job, cancel, invalidateSession, voiceConfigChanged, supersede,
    getByRequest(request: contract.PrepareRequest) { const id = byKey.get(keyOf(request)); return id ? jobs.get(id) : undefined },
    gate: (id: string) => ({ ...gate(id) }),
    countPrepare() { stats.prepares += 1 },
    stats: () => ({ ...stats, active: activeBySession.size }),
    dispose() { for (const j of jobs.values()) if (j.evictTimer) clearTimer(j.evictTimer) },
  }
}
