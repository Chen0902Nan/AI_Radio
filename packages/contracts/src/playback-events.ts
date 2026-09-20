import { JOB_STATES, type JobState, EVENTS, type EventType, DECISIONS, type DecisionType, type ValidationError, type ValidationResult } from './models.js'
import { makeId, isNonEmptyString, err, result, failure } from './validation-utils.js'

export function validateEvent(ev: unknown): ValidationResult<Record<string, unknown>> {
  const errors: ValidationError[] = []
  if (!ev || typeof ev !== 'object') return failure([err('', 'not_object', '事件必须是对象')])
  const e = ev as Record<string, unknown>
  const EVENT_LIST: string[] = Object.values(EVENTS)
  if (!EVENT_LIST.includes(e.type as EventType)) errors.push(err('type', 'invalid_event_type', `未知事件类型：${e.type}`))
  if (!Number.isFinite(Number(e.at))) errors.push(err('at', 'missing_at', '事件缺少时间戳 at'))
  const PLAYBACK_EVENT_TYPES: string[] = [EVENTS.TRACK_PLAYING, EVENTS.TRACK_ENDED, EVENTS.TRACK_FAILED, EVENTS.SEGUE_PLAYING, EVENTS.SEGUE_ENDED, EVENTS.SEGUE_FAILED]
  if (PLAYBACK_EVENT_TYPES.includes(e.type as EventType)) {
    if (!isNonEmptyString(e.itemId)) errors.push(err('itemId', 'missing_item_id', '播放事件缺少条目身份 itemId'))
    if (!isNonEmptyString(e.playInstanceId)) errors.push(err('playInstanceId', 'missing_play_instance_id', '播放事件缺少 playInstanceId（ended/首次 playing 去重依据）'))
  }
  if (e.type === EVENTS.TRACK_ENDED && typeof e.natural !== 'boolean') {
    errors.push(err('natural', 'missing_natural_flag', 'track-ended 必须显式携带 natural 布尔标记；只有 natural=true 累计'))
  }
  const SEGUE_EVENT_TYPES: EventType[] = [EVENTS.SEGUE_PLAYING, EVENTS.SEGUE_ENDED, EVENTS.SEGUE_FAILED]
  if (SEGUE_EVENT_TYPES.includes(e.type as EventType) && !isNonEmptyString(e.segueId)) {
    errors.push(err('segueId', 'missing_segue_id', '播报事件必须携带媒体身份 segueId'))
  }
  if (e.type === EVENTS.PREPARE_RESULT) {
    if (!isNonEmptyString(e.segueId)) errors.push(err('segueId', 'missing_segue_id', '准备结果缺少 segueId'))
    if (!isNonEmptyString(e.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '准备结果缺少 transitionId'))
    if (e.state !== undefined && !JOB_STATES.includes(e.state as JobState)) errors.push(err('state', 'invalid_job_state', '准备结果状态非法'))
  }
  return result(errors.length === 0, e, errors)
}

export function validateDecision(d: unknown): ValidationResult<Record<string, unknown>> {
  const errors: ValidationError[] = []
  if (!d || typeof d !== 'object') return failure([err('', 'not_object', '决定必须是对象')])
  const v = d as Record<string, unknown>
  const DECISION_LIST: string[] = Object.values(DECISIONS)
  if (!DECISION_LIST.includes(v.type as DecisionType)) errors.push(err('type', 'invalid_decision_type', `未知决定类型：${v.type}`))
  if (!Number.isFinite(Number(v.at))) errors.push(err('at', 'missing_at', '决定缺少时间戳 at'))
  for (const k of ['segueId', 'transitionId']) {
    if (v[k] !== undefined && !isNonEmptyString(v[k])) errors.push(err(k, `invalid_${k}`, `${k} 必须是非空字符串`))
  }
  return result(errors.length === 0, v, errors)
}

/**
 * 播放实例登记：落实「暂停恢复复用 playInstanceId，重新开始同一条目则新建」。
 * markEnded/markPlaying 都只在实例有效且未消费时返回 true，供调用方去重。
 */
export function createPlayInstanceTracker() {
  let seq = 0
  const active = new Map<string, { id: string; playingSeen: boolean; endedConsumed: boolean; replaced: boolean }>()
  const byId = new Map<string, { id: string; playingSeen: boolean; endedConsumed: boolean; replaced: boolean }>()
  function begin(itemId: string): string {
    const prev = active.get(itemId)
    if (prev) prev.replaced = true
    seq += 1
    const inst = { id: makeId('pi'), playingSeen: false, endedConsumed: false, replaced: false }
    active.set(itemId, inst)
    byId.set(inst.id, inst)
    return inst.id
  }
  function resume(itemId: string): string {
    const cur = active.get(itemId)
    if (cur && !cur.replaced && !cur.endedConsumed) return cur.id
    return begin(itemId)
  }
  function markPlaying(piid: string | null): boolean {
    const inst = piid ? byId.get(piid) : undefined
    if (!inst || inst.replaced || inst.playingSeen) return false
    inst.playingSeen = true
    return true
  }
  function markEnded(piid: string | null): boolean {
    const inst = piid ? byId.get(piid) : undefined
    if (!inst || inst.replaced || inst.endedConsumed) return false
    inst.endedConsumed = true
    return true
  }
  function current(itemId: string | null | undefined): string | null {
    const inst = itemId ? active.get(itemId) : undefined
    return inst && !inst.replaced ? inst.id : null
  }
  function clear(): void {
    active.clear()
    byId.clear()
  }
  return { begin, resume, markPlaying, markEnded, current, clear }
}

export type PlayInstanceTracker = ReturnType<typeof createPlayInstanceTracker>
