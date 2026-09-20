import { TRANSITION_STATES, type TransitionState, MAX_CONTEXT_CHARS, type Transition, type PrepareRequest, type SegueJob, type ValidationError, type ValidationResult } from './models.js'
import { isNonEmptyString, toInt, err, result, failure } from './validation-utils.js'

export function validateTransition(t: unknown, opts: { sessionId?: string; epoch?: number } = {}): ValidationResult<Transition> {
  const errors: ValidationError[] = []
  if (!t || typeof t !== 'object') return failure([err('', 'not_object', '机会必须是对象')])
  const v = t as Record<string, unknown>
  if (!isNonEmptyString(v.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '缺少 transitionId'))
  if (!isNonEmptyString(v.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
  if (typeof v.epoch !== 'number' || !Number.isSafeInteger(v.epoch) || v.epoch < 0) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
  if (typeof v.transitionSeq !== 'number' || !Number.isSafeInteger(v.transitionSeq) || v.transitionSeq < 0) errors.push(err('transitionSeq', 'invalid_transition_seq', 'transitionSeq 必须是非负安全整数'))
  if (!isNonEmptyString(v.fromItemId)) errors.push(err('fromItemId', 'missing_from_item_id', '缺少 fromItemId'))
  if (!isNonEmptyString(v.targetItemId)) errors.push(err('targetItemId', 'missing_target_item_id', '缺少 targetItemId'))
  else if (v.targetItemId === v.fromItemId) errors.push(err('targetItemId', 'same_from_and_target', '目标条目不能等于来源条目'))
  if (toInt(v.targetTrackId) === null) errors.push(err('targetTrackId', 'invalid_target_track_id', '缺少数字 targetTrackId'))
  if (!TRANSITION_STATES.includes(v.state as TransitionState)) errors.push(err('state', 'invalid_transition_state', `state 必须是 ${TRANSITION_STATES.join(' 或 ')}`))
  if (v.closedAt !== undefined && (typeof v.closedAt !== 'number' || !Number.isFinite(v.closedAt))) errors.push(err('closedAt', 'invalid_closed_at', '关闭时间必须是有限数字'))
  if (v.closedReason !== undefined && typeof v.closedReason !== 'string') errors.push(err('closedReason', 'invalid_closed_reason', '关闭原因必须是字符串'))
  if (opts.sessionId !== undefined && v.sessionId !== opts.sessionId) errors.push(err('sessionId', 'session_mismatch', '机会属于其他收听会话'))
  if (opts.epoch !== undefined && Number(v.epoch) !== Number(opts.epoch)) errors.push(err('epoch', 'epoch_mismatch', '机会属于旧编排版本'))
  return errors.length ? failure(errors) : result(true, { ...v, targetTrackId: toInt(v.targetTrackId), createdAt: Number(v.createdAt) || 0 } as unknown as Transition)
}

export function validatePrepareRequest(req: unknown): ValidationResult<PrepareRequest> {
  const errors: ValidationError[] = []
  if (!req || typeof req !== 'object') return failure([err('', 'not_object', '准备请求必须是对象')])
  const r = req as Record<string, unknown>
  if (!isNonEmptyString(r.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
  if (typeof r.epoch !== 'number' || !Number.isSafeInteger(r.epoch) || r.epoch < 0) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
  if (typeof r.transitionSeq !== 'number' || !Number.isSafeInteger(r.transitionSeq) || r.transitionSeq < 0) errors.push(err('transitionSeq', 'invalid_transition_seq', 'transitionSeq 必须是非负安全整数'))
  if (!isNonEmptyString(r.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '缺少 transitionId'))
  if (!isNonEmptyString(r.fromItemId)) errors.push(err('fromItemId', 'missing_from_item_id', '缺少 fromItemId'))
  if (!isNonEmptyString(r.targetItemId)) errors.push(err('targetItemId', 'missing_target_item_id', '缺少 targetItemId'))
  else if (isNonEmptyString(r.fromItemId) && r.targetItemId === r.fromItemId) {
    errors.push(err('targetItemId', 'same_from_and_target', '目标条目不能等于来源条目'))
  }
  if (toInt(r.targetTrackId) === null) errors.push(err('targetTrackId', 'invalid_target_track_id', '缺少数字 targetTrackId'))
  if (r.brief !== undefined && r.brief !== null && typeof r.brief !== 'string') {
    errors.push(err('brief', 'invalid_brief', 'brief 必须是字符串'))
  } else if (typeof r.brief === 'string' && r.brief.length > MAX_CONTEXT_CHARS) {
    errors.push(err('brief', 'brief_too_long', `上下文超过 ${MAX_CONTEXT_CHARS} 字上限`))
  }
  // 目标名称/歌手为可选上下文（客户端队列里已有，供文案稿使用），长度受限
  for (const [k, cap] of [['targetName', 200], ['targetArtists', 200]] as const) {
    const v = r[k]
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push(err(k, `invalid_${k}`, `${k} 必须是字符串`))
    } else if (typeof v === 'string' && v.length > cap) {
      errors.push(err(k, `invalid_${k}`, `${k} 超过 ${cap} 字上限`))
    }
  }
  if (errors.length) return failure(errors)
  return result(true, {
    sessionId: r.sessionId as string,
    epoch: Number(r.epoch),
    transitionSeq: Number(r.transitionSeq),
    transitionId: r.transitionId as string,
    fromItemId: r.fromItemId as string,
    targetItemId: r.targetItemId as string,
    targetTrackId: toInt(r.targetTrackId)!,
    // 目标名称/歌手是文案模块搜索与写稿的输入：校验后必须原样带过去，
    // 否则生成器只能拿到「曲目 <id> / 空歌手」（真实音源接口不返回名称）。
    targetName: typeof r.targetName === 'string' ? r.targetName.trim() : '',
    targetArtists: typeof r.targetArtists === 'string' ? r.targetArtists.trim() : '',
    brief: typeof r.brief === 'string' ? r.brief : '',
  })
}

/**
 * 任务与准备请求是否同一机会且同一目标：
 * 只有完全一致才允许复用任务；不同 payload 不能悄悄复用同一键。
 */
export function jobMatchesPrepare(job: Pick<SegueJob, 'transition'> | null | undefined, req: Partial<PrepareRequest> | null | undefined): { match: boolean; reason: string | null } {
  if (!job || !job.transition || !req) return { match: false, reason: 'missing_input' }
  const t = job.transition
  if (t.sessionId !== req.sessionId) return { match: false, reason: 'session_mismatch' }
  if (Number(t.epoch) !== Number(req.epoch)) return { match: false, reason: 'epoch_mismatch' }
  if (t.transitionSeq !== req.transitionSeq) return { match: false, reason: 'transition_seq_mismatch' }
  if (t.fromItemId !== req.fromItemId) return { match: false, reason: 'from_item_mismatch' }
  if (t.transitionId !== req.transitionId) return { match: false, reason: 'transition_mismatch' }
  if (t.targetItemId !== req.targetItemId) return { match: false, reason: 'target_item_mismatch' }
  if (toInt(t.targetTrackId) !== toInt(req.targetTrackId)) return { match: false, reason: 'target_track_mismatch' }
  return { match: true, reason: null }
}
