import { JOB_STATES, JOB_STAGES, type JobState, type JobStage, UNAVAILABLE_REASONS, type UnavailableReason, STALE_REASONS, type StaleReason, type Transition, type SegueJob, type ValidationError, type ValidationResult } from './models.js'
import { isNonEmptyString, err, result, failure } from './validation-utils.js'
import { validateSegueAudio } from './queue-validation.js'
import { validateTransition } from './transition-validation.js'
import { validateScript } from './script-validation.js'

/**
 * 准备任务校验：身份完整、状态合法、状态专属字段一致。
 * ready 成品必须携带通过校验的文案与同源音频；跨目标成品在这里被拒绝。
 */
export function validateSegueJob(job: unknown, opts: JobOptions = {}): ValidationResult<SegueJob> {
  const errors: ValidationError[] = []
  const push = (path: string, code: string, message: string) => errors.push(err(path, code, message))
  if (!job || typeof job !== 'object') return failure([err('', 'not_object', '任务必须是对象')])
  const j = job as Record<string, unknown>
  if (!isNonEmptyString(j.segueId)) push('segueId', 'missing_segue_id', '任务缺少 segueId')
  if (!JOB_STATES.includes(j.state as JobState)) push('state', 'invalid_job_state', `state 必须是 ${JOB_STATES.join('/')}`)
  if (!Number.isFinite(Number(j.createdAt))) push('createdAt', 'missing_created_at', '任务缺少 createdAt')

  const t = j.transition
  validateJobTransition(t, opts, push)
  validateStage(j.stage, push)

  if (j.state === 'ready') validateReady(j, t, push)
  validateTerminalState(j, push)
  validateJobMetadata(j, push)
  if (errors.length) return failure(errors)
  return normalizeJob(j, t)
}


type JobOptions = { sessionId?: string; epoch?: number; transitionId?: string }
type PushError = (path: string, code: string, message: string) => void
function validateJobTransition(t: unknown, opts: JobOptions, push: PushError): void {
  if (!t || typeof t !== 'object') {
    push('transition', 'missing_transition_identity', '任务必须携带机会身份（sessionId/epoch/transitionId/前后条目/目标歌曲）')
  } else {
    const r = validateTransition(t)
    r.errors.forEach((e) => push(`transition.${e.path}`, e.code, e.message))
    if (opts.sessionId !== undefined && (t as Transition).sessionId !== opts.sessionId) push('transition.sessionId', 'session_mismatch', '任务属于其他收听会话')
    if (opts.epoch !== undefined && Number((t as Transition).epoch) !== Number(opts.epoch)) push('transition.epoch', 'epoch_mismatch', '任务属于旧编排版本')
    if (opts.transitionId !== undefined && (t as Transition).transitionId !== opts.transitionId) push('transition.transitionId', 'transition_mismatch', '任务属于已关闭的机会')
  }
}

function validateReady(j: Record<string, unknown>, t: unknown, push: PushError): void {
  if (!j.script) push('script', 'missing_script', 'ready 任务必须携带文案成品')
  else {
    const expect = t && typeof t === 'object'
      ? { targetTrackId: (t as Transition).targetTrackId as number | undefined, targetItemId: (t as Transition).targetItemId, transitionId: (t as Transition).transitionId }
      : {}
    const r = validateScript(j.script, expect)
    r.errors.forEach((e) => push(`script.${e.path}`, e.code, e.message))
  }
  if (!j.audio || typeof j.audio !== 'object') {
    push('audio', 'missing_audio', 'ready 任务必须携带音频成品')
  } else {
    validateSegueAudio(j.audio).errors.forEach(e => push(`audio.${e.path}`, e.code, e.message))
  }
}
function validateTerminalState(j: Record<string, unknown>, push: PushError): void {
  if (j.state === 'preparing' && (j.script || j.audio)) {
    push('state', 'premature_result', 'preparing 任务不应提前携带成品')
  }
  if (j.state === 'unavailable') {
    if (!UNAVAILABLE_REASONS.includes(j.reason as UnavailableReason)) {
      push('reason', 'invalid_unavailable_reason', `不可用原因必须在枚举内：${UNAVAILABLE_REASONS.join('/')}`)
    }
    if (j.audio) push('audio', 'unavailable_with_audio', 'unavailable 任务不应携带音频成品')
  }
  if (j.state === 'stale' && !STALE_REASONS.includes(j.reason as StaleReason)) {
    push('reason', 'invalid_stale_reason', `作废原因必须在枚举内：${STALE_REASONS.join('/')}`)
  }
}
function validateJobMetadata(j: Record<string, unknown>, push: PushError): void {
  for (const key of ['reason', 'message', 'code']) {
    if (j[key] != null && typeof j[key] !== 'string') push(key, 'invalid_job_text', '任务字段必须是字符串')
  }
  validateDeviations(j.deviations, push)
  if (j.updatedAt !== undefined && (typeof j.updatedAt !== 'number' || !Number.isFinite(j.updatedAt))) push('updatedAt', 'invalid_updated_at', '更新时间必须是数字')
  if (j.script != null) validateScript(j.script).errors.forEach(e => push(`script.${e.path}`, e.code, e.message))
  if (j.audio != null) validateSegueAudio(j.audio).errors.forEach(e => push(`audio.${e.path}`, e.code, e.message))
}

function normalizeJob(j: Record<string, unknown>, t: unknown): ValidationResult<SegueJob> {
  return result(true, { ...j, createdAt: Number(j.createdAt), transition: validateTransition(t).value!,
    ...(j.script != null ? { script: validateScript(j.script).value! } : {}),
    ...(j.audio != null ? { audio: validateSegueAudio(j.audio).value! } : {}),
  } as SegueJob)
}

function validateDeviations(value: unknown, push: PushError): void {
  if (value != null && (!Array.isArray(value) || value.some(d => !d || typeof d !== 'object' || typeof d.code !== 'string'))) push('deviations', 'invalid_deviations', '偏差必须携带 code')
}

function validateStage(stage: unknown, push: PushError): void {
  if (stage !== undefined && stage !== null && !JOB_STAGES.includes(stage as JobStage)) {
    push('stage', 'invalid_stage', `stage 必须是 ${JOB_STAGES.join(' 或 ')}`)
  }

}
