import { type TrackItem, type SegueItem, type Transition } from './models.js'
import { makeId, toInt } from './validation-utils.js'

/**
 * 旧歌曲对象 → 节目条目（适配边界）：数字 id 映射为 trackId 后丢弃，
 * 每次入队生成新的 itemId——同一首歌重复入队也是不同条目。
 */
export function makeTrackItem(track: { trackId?: unknown; id?: unknown; name?: unknown; artists?: unknown; album?: unknown; durationMs?: unknown; auto?: unknown; fromCodex?: unknown; selectionId?: unknown; selectionSource?: unknown } | null | undefined, opts: { itemId?: string; addedAt?: number } = {}): TrackItem {
  if (!track || typeof track !== 'object') throw new TypeError('makeTrackItem: 需要曲目对象')
  const trackId = toInt(track.trackId !== undefined ? track.trackId : track.id)
  if (trackId === null) throw new TypeError('makeTrackItem: 缺少可用的数字曲目 id（旧结构 id 或 trackId）')
  return {
    itemId: opts.itemId || makeId('itn'),
    type: 'track',
    trackId,
    name: String(track.name || ''),
    artists: String(track.artists || ''),
    album: String(track.album || ''),
    durationMs: Number.isFinite(Number(track.durationMs)) && Number(track.durationMs) >= 0 ? Number(track.durationMs) : 0,
    auto: Boolean(track.auto),
    fromCodex: Boolean(track.fromCodex),
    ...(typeof track.selectionId === 'string' ? {selectionId: track.selectionId} : {}),
    ...(track.selectionSource === 'library' || track.selectionSource === 'discovery' ? {selectionSource: track.selectionSource} : {}),
    addedAt: Number(opts.addedAt) || Date.now(),
  }
}

/** 播报条目：携带 segueId 与机会绑定，绝不携带歌曲数字 id。 */
export function makeSegueItem(input: Partial<SegueItem> = {}): SegueItem {
  return {
    itemId: input.itemId || makeId('itn'),
    type: 'segue',
    segueId: String(input.segueId || makeId('sg')),
    transitionId: String(input.transitionId || ''),
    fromItemId: String(input.fromItemId || ''),
    targetItemId: String(input.targetItemId || ''),
    targetTrackId: input.targetTrackId === undefined ? null : toInt(input.targetTrackId),
    script: input.script || null,
    audio: input.audio || null,
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** 一次「当前歌曲结束 → 目标歌曲开始」的串场机会。 */
export function makeTransition(input: Partial<Transition> = {}): Transition {
  return {
    transitionId: input.transitionId || makeId('tr'),
    sessionId: String(input.sessionId || ''),
    epoch: Number(input.epoch) || 0,
    transitionSeq: Number(input.transitionSeq) || 0,
    fromItemId: String(input.fromItemId || ''),
    targetItemId: String(input.targetItemId || ''),
    targetTrackId: toInt(input.targetTrackId),
    state: 'open',
    createdAt: Number(input.createdAt) || Date.now(),
  }
}

/** 关闭机会（幂等）；关闭后所有迟到结果失去排程资格，机会不重新打开。 */
export function closeTransition<T extends Transition>(transition: T | null | undefined, reason = 'closed'): T {
  if (!transition || transition.state === 'closed') return transition as T
  return { ...transition, state: 'closed', closedAt: Date.now(), closedReason: String(reason) }
}

export function isTransitionOpen(transition: Transition | null | undefined): boolean {
  return Boolean(transition) && transition!.state === 'open'
}

/** 任务复用键：同一个 (sessionId, epoch, transitionId) 的重复提交复用任务。 */
export function transitionKey(t: Pick<Transition, 'sessionId' | 'epoch' | 'transitionId'> | null | undefined): string {
  return `${t && t.sessionId}#${Number(t && t.epoch)}#${t && t.transitionId}`
}
