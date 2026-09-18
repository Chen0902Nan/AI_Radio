/**
 * 节目契约（TS 迁移自 public/program-contract.js）：歌曲与 DJ 播报共用的数据形状、
 * 身份语义与结构校验。
 *
 * 身份区分（实现不得混用）：
 *  - sessionId  当前收听会话；停止后旧会话的结果一律失效。
 *  - epoch      编排版本：切来源、应用新计划或重置节目时更新。不能用暂停也会变化的 playToken 代替。
 *  - itemId     一次入队的节目条目身份；同一首歌重复入队也不同。
 *  - trackId    音乐平台歌曲 ID；旧歌曲对象的数字 id 只在 makeTrackItem 适配边界映射，
 *               不用于识别一次串场机会。
 *  - transitionId  一次「当前歌曲结束 → 目标歌曲开始」的串场机会；机会关闭后不重新打开。
 *  - segueId    一次准备任务及其播报成品身份；用于查询、取消与媒体归属。
 *  - playInstanceId 一次实际播放尝试：暂停恢复复用，重新开始同一条目则新建。
 *  - playToken  播放执行代次：控制加载/播放回调能否生效，与准备任务版本分开。
 *
 * 验证边界：本模块的结构校验只能证明「形状正确、身份一致、归因文字存在」，
 * 不能程序性证明来源内容属实。
 */
export const PROGRAM_TYPES = ['track', 'segue'] as const
export const STORY_STATUSES = ['sourced', 'basic_only'] as const
export const CLAIM_KINDS = ['documented', 'unverified_account'] as const
export const JOB_STATES = ['preparing', 'ready', 'unavailable', 'stale'] as const
export const JOB_STAGES = ['research', 'synthesis'] as const
export const TRANSITION_STATES = ['open', 'closed'] as const

export type ProgramType = (typeof PROGRAM_TYPES)[number]
export type StoryStatus = (typeof STORY_STATUSES)[number]
export type ClaimKind = (typeof CLAIM_KINDS)[number]
export type JobState = (typeof JOB_STATES)[number]
export type JobStage = (typeof JOB_STAGES)[number]
export type TransitionState = (typeof TRANSITION_STATES)[number]

/** 任务不可用原因（失败状态分开记录）。 */
export const UNAVAILABLE_REASONS = [
  'voice_not_configured',
  'script_failed',
  'synthesis_failed',
  'audio_invalid',
  'audio_too_long',
  'target_unplayable',
  'cancelled',
  'cooldown_active',
] as const
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/** 任务作废原因（stale = 旧结果失去排程资格）。 */
export const STALE_REASONS = [
  'transition_closed',
  'superseded',
  'session_ended',
  'epoch_changed',
  'server_restart',
  'expired',
] as const
export type StaleReason = (typeof STALE_REASONS)[number]

/** 文案阶段失败码（与 Codex 适配层的失败分类保持一致）。 */
export const SCRIPT_FAILURE_CODES = ['timeout', 'quota', 'auth', 'invalid_output', 'network', 'error'] as const
export type ScriptFailureCode = (typeof SCRIPT_FAILURE_CODES)[number]

/** 语音阶段失败码。 */
export const TTS_FAILURE_CODES = [
  'not_configured', 'auth', 'quota', 'rate_limited', 'timeout',
  'bad_audio', 'too_long', 'network', 'cancelled', 'error',
] as const
export type TtsFailureCode = (typeof TTS_FAILURE_CODES)[number]

/** 事件输入形状（控制器接收、播放器上报）。 */
export const EVENTS = {
  TRACK_PLAYING: 'track-playing',
  TRACK_ENDED: 'track-ended',
  TRACK_FAILED: 'track-failed',
  SEGUE_PLAYING: 'segue-playing',
  SEGUE_ENDED: 'segue-ended',
  SEGUE_FAILED: 'segue-failed',
  QUEUE_CHANGED: 'queue-changed',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  STOPPED: 'stopped',
  PREPARE_RESULT: 'prepare-result',
} as const
export type EventType = (typeof EVENTS)[keyof typeof EVENTS]

/** 决定输出形状（控制器返回、执行）。 */
export const DECISIONS = {
  PREPARE: 'prepare',
  CANCEL: 'cancel',
  PLAY_SEGUE: 'play-segue',
  CONTINUE_TRACK: 'continue-track',
  NONE: 'none',
} as const
export type DecisionType = (typeof DECISIONS)[keyof typeof DECISIONS]

/**
 * 文案长度边界：15–30 秒目标，按 3.3–4.7 字/秒折算约 50–140 字。
 * sourced 稿越界拒绝；basic_only 短于下限允许降级使用并记录偏差。
 */
export const SCRIPT_BOUNDS = { minChars: 50, maxChars: 140 } as const
/** 音频时长硬上限：超过 30 秒不进入正式节目。 */
export const MAX_AUDIO_MS = 30000
/** 准备请求允许携带的有限上下文长度。 */
export const MAX_CONTEXT_CHARS = 200
/** 来源只保存支持陈述所需的短摘录/摘要，不缓存整篇文章。 */
export const SOURCE_MAX_EVIDENCE_CHARS = 400
/** 音频地址前缀：ready 成品必须经同源路由提供，不接受外部 URL。 */
export const AUDIO_URL_PREFIX = '/api/dj/audio/'

/* ---------- 数据形状 ---------- */

export interface TrackItem {
  itemId: string
  type: 'track'
  trackId: number
  name: string
  artists: string
  album: string
  durationMs: number
  auto: boolean
  fromCodex: boolean
  selectionId?: string
  selectionSource?: 'library' | 'discovery'
  addedAt: number
}

export interface SegueAudio {
  assetId: string
  url: string
  durationMs: number
  bytes: number
}

export interface SegueItem {
  itemId: string
  type: 'segue'
  segueId: string
  transitionId: string
  fromItemId: string
  targetItemId: string
  targetTrackId: number | null
  script: SegueScript | null
  audio: SegueAudio | null
  createdAt: number
}

export type QueueItem = TrackItem | SegueItem

export interface Transition {
  transitionId: string
  sessionId: string
  epoch: number
  fromItemId: string
  targetItemId: string
  targetTrackId: number | null
  state: TransitionState
  createdAt: number
  closedAt?: number
  closedReason?: string
}

export interface PrepareRequest {
  sessionId: string
  epoch: number
  transitionId: string
  fromItemId: string
  targetItemId: string
  targetTrackId: number
  targetName?: string
  targetArtists?: string
  brief?: string
}

export interface Claim {
  id: string
  text: string
  kind: ClaimKind
  sourceIds: string[]
  spokenAttribution?: string
}

export interface Source {
  id: string
  url: string
  title: string
  publisherOrAuthor?: string
  evidence: string
  retrievedAt: string
}

export interface SegueScript {
  targetTrackId: number
  targetItemId: string
  transitionId: string
  targetName?: string
  targetArtists?: string
  storyStatus: StoryStatus
  scriptText: string
  claims: Claim[]
  sources: Source[]
}

export interface SegueJob {
  segueId: string
  state: JobState
  stage?: JobStage | null
  createdAt: number
  updatedAt?: number
  transition: Transition
  reason?: string | null
  message?: string | null
  code?: string | null
  deviations?: Array<{ code: string; [k: string]: unknown }> | null
  script?: SegueScript | null
  audio?: SegueAudio | null
}

export interface ValidationError {
  path: string
  code: string
  message: string
}

export interface ValidationDeviation {
  code: string
  message: string
  [k: string]: unknown
}

export interface ValidationResult<T> {
  ok: boolean
  value?: T
  errors: ValidationError[]
  deviations: ValidationDeviation[]
}

/* ---------- 基础工具 ---------- */

let __seq = 0
export function makeId(prefix: string): string {
  __seq = (__seq + 1) % 0xffff
  return `${prefix}_${Date.now().toString(36)}${__seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 数字或数字字符串 → 非负整数；否则 null。用于 trackId/epoch 等平台数字身份。 */
function toInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const err = (path: string, code: string, message: string): ValidationError => ({ path, code, message })

function result<T>(ok: boolean, value: T | undefined, errors: ValidationError[] = [], deviations: ValidationDeviation[] = []): ValidationResult<T> {
  return { ok, value, errors, deviations }
}

/** 拒绝分支：value 恒为 undefined，由调用点推断目标类型。 */
function failure<T>(errors: ValidationError[], deviations: ValidationDeviation[] = []): ValidationResult<T> {
  return { ok: false, value: undefined, errors, deviations }
}

/** 估算中文播报时长（秒）：CJK/全角字符记 1，其他可见字符记 0.5，忽略空白。 */
export function estimateSpeechSeconds(text: unknown, charsPerSecond?: number): number {
  const s = String(text || '')
  let units = 0
  for (const ch of s) {
    if (/\s/.test(ch)) continue
    units += /[　-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.5
  }
  const cps = Number(charsPerSecond) > 0 ? Number(charsPerSecond) : 4
  return units / cps
}

/* ---------- 身份工厂 ---------- */

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
    durationMs: Number(track.durationMs) || 0,
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

/* ---------- 校验器 ---------- */

export function validateTransition(t: unknown, opts: { sessionId?: string; epoch?: number } = {}): ValidationResult<Transition> {
  const errors: ValidationError[] = []
  if (!t || typeof t !== 'object') return failure([err('', 'not_object', '机会必须是对象')])
  const v = t as Record<string, unknown>
  if (!isNonEmptyString(v.transitionId)) errors.push(err('transitionId', 'missing_transition_id', '缺少 transitionId'))
  if (!isNonEmptyString(v.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
  if (!Number.isFinite(Number(v.epoch))) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
  if (!isNonEmptyString(v.fromItemId)) errors.push(err('fromItemId', 'missing_from_item_id', '缺少 fromItemId'))
  if (!isNonEmptyString(v.targetItemId)) errors.push(err('targetItemId', 'missing_target_item_id', '缺少 targetItemId'))
  else if (v.targetItemId === v.fromItemId) errors.push(err('targetItemId', 'same_from_and_target', '目标条目不能等于来源条目'))
  if (toInt(v.targetTrackId) === null) errors.push(err('targetTrackId', 'invalid_target_track_id', '缺少数字 targetTrackId'))
  if (!TRANSITION_STATES.includes(v.state as TransitionState)) errors.push(err('state', 'invalid_transition_state', `state 必须是 ${TRANSITION_STATES.join(' 或 ')}`))
  if (opts.sessionId !== undefined && v.sessionId !== opts.sessionId) errors.push(err('sessionId', 'session_mismatch', '机会属于其他收听会话'))
  if (opts.epoch !== undefined && Number(v.epoch) !== Number(opts.epoch)) errors.push(err('epoch', 'epoch_mismatch', '机会属于旧编排版本'))
  return result(errors.length === 0, v as unknown as Transition, errors)
}

export function validateQueueItem(item: unknown): ValidationResult<QueueItem> {
  const errors: ValidationError[] = []
  if (!item || typeof item !== 'object') return failure([err('', 'not_object', '节目条目必须是对象')])
  const v = item as Record<string, unknown>
  if (!isNonEmptyString(v.itemId)) errors.push(err('itemId', 'missing_item_id', '条目缺少 itemId'))
  if (v.type === undefined && v.id !== undefined && toInt(v.id) !== null) {
    errors.push(err('type', 'legacy_track_shape', '旧歌曲对象（只有数字 id）需先经 makeTrackItem 适配为节目条目'))
  } else if (!PROGRAM_TYPES.includes(v.type as ProgramType)) {
    errors.push(err('type', 'invalid_program_type', `type 必须是 ${PROGRAM_TYPES.join(' 或 ')}`))
  }
  if (v.type === 'track') {
    if (toInt(v.trackId) === null) errors.push(err('trackId', 'invalid_track_id', '歌曲条目缺少数字 trackId'))
  }
  if (v.type === 'segue') {
    if (!isNonEmptyString(v.segueId)) errors.push(err('segueId', 'missing_segue_id', '播报条目缺少 segueId'))
    if (Object.prototype.hasOwnProperty.call(v, 'id') && Number.isFinite(Number(v.id))) {
      errors.push(err('id', 'segue_masquerades_track_id', '播报条目不能携带歌曲数字 id'))
    }
  }
  return result(errors.length === 0, v as unknown as QueueItem, errors)
}

export function validatePrepareRequest(req: unknown): ValidationResult<PrepareRequest> {
  const errors: ValidationError[] = []
  if (!req || typeof req !== 'object') return failure([err('', 'not_object', '准备请求必须是对象')])
  const r = req as Record<string, unknown>
  if (!isNonEmptyString(r.sessionId)) errors.push(err('sessionId', 'missing_session_id', '缺少 sessionId'))
  if (!Number.isFinite(Number(r.epoch))) errors.push(err('epoch', 'invalid_epoch', 'epoch 必须是数字'))
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
  if (t.transitionId !== req.transitionId) return { match: false, reason: 'transition_mismatch' }
  if (t.targetItemId !== req.targetItemId) return { match: false, reason: 'target_item_mismatch' }
  if (toInt(t.targetTrackId) !== toInt(req.targetTrackId)) return { match: false, reason: 'target_track_mismatch' }
  return { match: true, reason: null }
}

/**
 * 来源校验。论坛、个人文章、乐迷分享都可以作为来源（不设官方白名单），
 * 只要求是实际访问到的 http(s) 页面并保留短摘录与检索时间。
 */
export function validateSources(sources: unknown): ValidationResult<Source[]> {
  const errors: ValidationError[] = []
  if (!Array.isArray(sources)) return failure([err('sources', 'sources_not_array', 'sources 必须是数组')])
  const seen = new Set<string>()
  sources.forEach((s, i) => {
    const at = `sources[${i}]`
    if (!s || typeof s !== 'object') {
      errors.push(err(at, 'invalid_source', '来源必须是对象'))
      return
    }
    const src = s as Record<string, unknown>
    if (!isNonEmptyString(src.id)) errors.push(err(`${at}.id`, 'invalid_source_id', '来源缺少 id'))
    else if (seen.has(src.id)) errors.push(err(`${at}.id`, 'duplicate_source_id', `来源 id 重复：${src.id}`))
    else seen.add(src.id)
    if (!/^https?:\/\//i.test(typeof src.url === 'string' ? src.url : '')) {
      errors.push(err(`${at}.url`, 'invalid_source_url', '来源 url 必须是 http(s) 绝对链接（接受论坛/个人页面，无白名单）'))
    }
    if (!isNonEmptyString(src.title)) errors.push(err(`${at}.title`, 'missing_source_title', '来源缺少标题'))
    if (!isNonEmptyString(src.evidence)) {
      errors.push(err(`${at}.evidence`, 'missing_source_evidence', '来源缺少支持陈述的摘录/摘要'))
    } else if (src.evidence.length > SOURCE_MAX_EVIDENCE_CHARS) {
      errors.push(err(`${at}.evidence`, 'evidence_too_long', `来源摘录超过 ${SOURCE_MAX_EVIDENCE_CHARS} 字，只保存短摘录或摘要`))
    }
    if (src.retrievedAt === undefined || Number.isNaN(Date.parse(src.retrievedAt as string))) {
      errors.push(err(`${at}.retrievedAt`, 'invalid_retrieved_at', '来源缺少可解析的检索时间 retrievedAt'))
    }
  })
  return result(errors.length === 0, sources as Source[], errors)
}

/**
 * 文案成品校验（结构层）：非空稿、长度范围、目标身份、来源引用存在、
 * 未证实说法的播出归因。它不能证明来源支持内容（见文件头验证边界）。
 * opts 可传 {targetTrackId, targetItemId, transitionId, minChars, maxChars} 做机会一致性核对。
 */
export function validateScript(script: unknown, opts: { targetTrackId?: number; targetItemId?: string; transitionId?: string; minChars?: number; maxChars?: number } = {}): ValidationResult<SegueScript> {
  const errors: ValidationError[] = []
  const deviations: ValidationDeviation[] = []
  const push = (path: string, code: string, message: string) => errors.push(err(path, code, message))
  if (!script || typeof script !== 'object') return failure([err('', 'not_object', '文案结果必须是对象')])
  const s = script as Record<string, unknown>

  // 目标身份是跨目标检测的结构基础：成品必须记录为哪个机会、哪首歌而写。
  if (toInt(s.targetTrackId) === null) push('targetTrackId', 'invalid_target_track_id', '文案必须记录目标歌曲的数字 id')
  if (!isNonEmptyString(s.targetItemId)) push('targetItemId', 'missing_target_item_id', '文案必须记录目标条目 itemId')
  if (!isNonEmptyString(s.transitionId)) push('transitionId', 'missing_transition_id', '文案必须记录当前机会 transitionId')
  if (opts.targetTrackId !== undefined && toInt(s.targetTrackId) !== null && toInt(s.targetTrackId) !== toInt(opts.targetTrackId)) {
    push('targetTrackId', 'target_mismatch', '文案不是为当前目标歌曲生成的')
  }
  if (opts.targetItemId !== undefined && s.targetItemId !== opts.targetItemId) {
    push('targetItemId', 'target_mismatch', '文案不是为当前目标条目生成的')
  }
  if (opts.transitionId !== undefined && s.transitionId !== opts.transitionId) {
    push('transitionId', 'transition_mismatch', '文案不是为当前机会生成的')
  }

  const text = typeof s.scriptText === 'string' ? s.scriptText : ''
  if (!text.trim()) push('scriptText', 'empty_script', '文案不能为空')
  if (!STORY_STATUSES.includes(s.storyStatus as StoryStatus)) {
    push('storyStatus', 'invalid_story_status', `storyStatus 必须是 ${STORY_STATUSES.join(' 或 ')}`)
  }
  const isSourced = s.storyStatus === 'sourced'

  // 来源
  const sources = Array.isArray(s.sources) ? s.sources : null
  if (!sources) push('sources', 'sources_not_array', 'sources 必须是数组')
  if (sources && !isSourced && sources.length > 0) {
    push('sources', 'basic_only_with_sources', 'basic_only 表示查无可用资料，不应携带来源')
  }
  if (sources && isSourced) {
    if (sources.length === 0) push('sources', 'no_sources', 'sourced 文案必须至少携带一个来源')
    validateSources(sources).errors.forEach((e) => push(e.path, e.code, e.message))
  }

  // 陈述
  const claims = Array.isArray(s.claims) ? s.claims : null
  if (!claims) push('claims', 'claims_not_array', 'claims 必须是数组')
  if (claims) {
    if (isSourced && claims.length === 0) push('claims', 'no_claims', 'sourced 文案必须至少包含一条陈述')
    if (!isSourced && claims.length > 0) push('claims', 'basic_only_with_claims', 'basic_only 不应携带陈述')
    const sourceIds = new Set((sources || []).map((x: unknown) => (x as Source)?.id).filter(isNonEmptyString))
    const seenClaimIds = new Set<string>()
    claims.forEach((claim, i) => {
      const at = `claims[${i}]`
      if (!claim || typeof claim !== 'object') {
        push(at, 'invalid_claim', '陈述必须是对象')
        return
      }
      const c = claim as Record<string, unknown>
      if (!isNonEmptyString(c.id)) push(`${at}.id`, 'invalid_claim_id', '陈述缺少 id')
      else if (seenClaimIds.has(c.id)) push(`${at}.id`, 'duplicate_claim_id', `陈述 id 重复：${c.id}`)
      else seenClaimIds.add(c.id)
      if (!isNonEmptyString(c.text)) push(`${at}.text`, 'empty_claim_text', '陈述缺少内容')
      if (!CLAIM_KINDS.includes(c.kind as ClaimKind)) {
        push(`${at}.kind`, 'invalid_claim_kind', `kind 必须是 ${CLAIM_KINDS.join(' 或 ')}`)
      }
      if (!Array.isArray(c.sourceIds)) {
        push(`${at}.sourceIds`, 'claim_without_source', '陈述必须以数组形式引用来源')
      } else if (c.sourceIds.length === 0) {
        push(`${at}.sourceIds`, 'claim_without_source', '陈述必须引用至少一个来源')
      } else {
        const missing = c.sourceIds.filter((id: unknown) => !sourceIds.has(id as string))
        if (missing.length) push(`${at}.sourceIds`, 'missing_source_reference', `引用了不存在的来源：${missing.join(', ')}`)
      }
      if (c.spokenAttribution !== undefined && typeof c.spokenAttribution !== 'string') {
        push(`${at}.spokenAttribution`, 'invalid_spoken_attribution', 'spokenAttribution 必须是字符串')
      } else if (c.kind === 'unverified_account') {
        // 民间说法必须在播报文字里自然说明出处与说法性质，隐藏元数据标记不算。
        if (!isNonEmptyString(c.spokenAttribution)) {
          push(`${at}.spokenAttribution`, 'missing_spoken_attribution', '未证实说法必须携带实际播出的归因文字')
        } else if (text && !text.includes(c.spokenAttribution)) {
          push(`${at}.spokenAttribution`, 'attribution_missing_in_script', '归因文字必须出现在播报正文中，而不是只在元数据里')
        }
      }
      // documented 的 spokenAttribution 可选：网页展示来源即可，不强制口播归因。
    })
  }

  // 长度范围
  const minChars = Number(opts.minChars) > 0 ? Number(opts.minChars) : SCRIPT_BOUNDS.minChars
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : SCRIPT_BOUNDS.maxChars
  if (text.trim()) {
    if (text.length > maxChars) {
      push('scriptText', 'script_too_long', `文案超过 ${maxChars} 字上限（约 30 秒）`)
    } else if (text.length < minChars) {
      if (isSourced) {
        push('scriptText', 'script_too_short', `资料型文案不足 ${minChars} 字（约 15 秒），应收窄内容或降级为 basic_only`)
      } else {
        // 契约允许：少于 15 秒的有效基础介绍可以降级使用，但要明确记录偏差。
        deviations.push({
          code: 'short_basic_intro',
          message: `基础介绍短于目标长度 ${minChars} 字，按契约降级使用`,
          estimatedSeconds: estimateSpeechSeconds(text),
        })
      }
    }
  }

  return result(errors.length === 0, s as unknown as SegueScript, errors, deviations)
}

/**
 * 准备任务校验：身份完整、状态合法、状态专属字段一致。
 * ready 成品必须携带通过校验的文案与同源音频；跨目标成品在这里被拒绝。
 */
export function validateSegueJob(job: unknown, opts: { sessionId?: string; epoch?: number; transitionId?: string } = {}): ValidationResult<SegueJob> {
  const errors: ValidationError[] = []
  const push = (path: string, code: string, message: string) => errors.push(err(path, code, message))
  if (!job || typeof job !== 'object') return failure([err('', 'not_object', '任务必须是对象')])
  const j = job as Record<string, unknown>
  if (!isNonEmptyString(j.segueId)) push('segueId', 'missing_segue_id', '任务缺少 segueId')
  if (!JOB_STATES.includes(j.state as JobState)) push('state', 'invalid_job_state', `state 必须是 ${JOB_STATES.join('/')}`)
  if (!Number.isFinite(Number(j.createdAt))) push('createdAt', 'missing_created_at', '任务缺少 createdAt')

  const t = j.transition
  if (!t || typeof t !== 'object') {
    push('transition', 'missing_transition_identity', '任务必须携带机会身份（sessionId/epoch/transitionId/前后条目/目标歌曲）')
  } else {
    const r = validateTransition(t)
    r.errors.forEach((e) => push(`transition.${e.path}`, e.code, e.message))
    if (opts.sessionId !== undefined && (t as Transition).sessionId !== opts.sessionId) push('transition.sessionId', 'session_mismatch', '任务属于其他收听会话')
    if (opts.epoch !== undefined && Number((t as Transition).epoch) !== Number(opts.epoch)) push('transition.epoch', 'epoch_mismatch', '任务属于旧编排版本')
    if (opts.transitionId !== undefined && (t as Transition).transitionId !== opts.transitionId) push('transition.transitionId', 'transition_mismatch', '任务属于已关闭的机会')
  }

  if (j.stage !== undefined && j.stage !== null && !JOB_STAGES.includes(j.stage as JobStage)) {
    push('stage', 'invalid_stage', `stage 必须是 ${JOB_STAGES.join(' 或 ')}`)
  }

  if (j.state === 'ready') {
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
      const a = j.audio as Record<string, unknown>
      if (!isNonEmptyString(a.assetId)) push('audio.assetId', 'invalid_asset_id', '音频成品缺少 assetId')
      const url = typeof a.url === 'string' ? a.url : ''
      if (!url.startsWith(AUDIO_URL_PREFIX) || url.includes('://')) {
        push('audio.url', 'invalid_audio_url', `音频必须通过同源 ${AUDIO_URL_PREFIX} 地址提供，不接受外部 URL`)
      }
      const dur = Number(a.durationMs)
      if (!Number.isFinite(dur) || dur <= 0) {
        push('audio.durationMs', 'invalid_audio_duration', '音频成品必须记录正数时长 durationMs')
      } else if (dur > MAX_AUDIO_MS) {
        push('audio.durationMs', 'audio_too_long', `音频超过 ${MAX_AUDIO_MS / 1000} 秒上限，不能进入正式节目`)
      }
    }
  }
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
  return result(errors.length === 0, j as unknown as SegueJob, errors)
}

/* ---------- 事件与决定 ---------- */

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

/* ---------- 样例（供独立开发与测试；全部虚构，不含真实凭据） ---------- */

export function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T)
}

const SAMPLE_TEMPLATES = {
  track: { trackId: 900002, name: '灯塔', artists: '另一位歌手', album: '示例专辑', durationMs: 210000 },
  trackA: { trackId: 900001, name: '夜航西飞', artists: '示例歌手', album: '示例专辑', durationMs: 245000 },
  prepareRequest: {
    sessionId: 'sess-demo-1',
    epoch: 7,
    transitionId: 'tr_demo_1',
    fromItemId: 'itn_demo_1',
    targetItemId: 'itn_demo_2',
    targetTrackId: 900002,
    brief: '深夜，安静一点',
  },
  transition: {
    transitionId: 'tr_demo_1',
    sessionId: 'sess-demo-1',
    epoch: 7,
    fromItemId: 'itn_demo_1',
    targetItemId: 'itn_demo_2',
    targetTrackId: 900002,
    state: 'open' as const,
    createdAt: 1726459200000,
  },
  sourcedScript: {
    targetTrackId: 900002,
    targetItemId: 'itn_demo_2',
    transitionId: 'tr_demo_1',
    targetName: '灯塔',
    targetArtists: '另一位歌手',
    storyStatus: 'sourced' as const,
    scriptText:
      '接下来这首《灯塔》来自「另一位歌手」。据乐迷在「独立音乐论坛」分享的说法，灵感来自一次深夜看海的经历；专辑介绍也提到录制只用了三天。来听听。',
    claims: [
      {
        id: 'c1',
        text: '创作灵感与一次深夜看海的经历有关（乐迷说法，未经证实）',
        kind: 'unverified_account' as const,
        sourceIds: ['s1'],
        spokenAttribution: '据乐迷在「独立音乐论坛」分享的说法',
      },
      {
        id: 'c2',
        text: '专辑介绍提到录制只用了三天',
        kind: 'documented' as const,
        sourceIds: ['s2'],
        spokenAttribution: '',
      },
    ],
    sources: [
      {
        id: 's1',
        url: 'https://forum.example.com/thread/12345',
        title: '《灯塔》创作背景讨论帖',
        publisherOrAuthor: '乐迷「听海的人」',
        evidence: '楼主称这首歌的灵感来自一次深夜看海的经历……',
        retrievedAt: '2026-09-16T10:00:00Z',
      },
      {
        id: 's2',
        url: 'https://music.example.com/reviews/lighthouse',
        title: '《灯塔》专辑介绍',
        publisherOrAuthor: '示例乐评',
        evidence: '专辑介绍写道，整张专辑的录制只用了三天。',
        retrievedAt: '2026-09-16T10:05:00Z',
      },
    ],
  },
  basicOnlyScript: {
    targetTrackId: 900002,
    targetItemId: 'itn_demo_2',
    transitionId: 'tr_demo_1',
    targetName: '灯塔',
    targetArtists: '另一位歌手',
    storyStatus: 'basic_only' as const,
    scriptText: '接下来是「另一位歌手」的《灯塔》，一首适合深夜安静收听的歌。',
    claims: [] as Claim[],
    sources: [] as Source[],
  },
}

const JOB_TEMPLATES = {
  preparingJob: () => ({
    segueId: 'sg_demo_1',
    state: 'preparing' as const,
    stage: 'research' as const,
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
  readyJob: () => ({
    segueId: 'sg_demo_1',
    state: 'ready' as const,
    createdAt: 1726459200000,
    updatedAt: 1726459260000,
    transition: clone(SAMPLE_TEMPLATES.transition),
    script: clone(SAMPLE_TEMPLATES.sourcedScript),
    audio: { assetId: 'asset_demo_1', url: '/api/dj/audio/asset_demo_1', durationMs: 21300 },
  }),
  unavailableJob: () => ({
    segueId: 'sg_demo_2',
    state: 'unavailable' as const,
    reason: 'voice_not_configured',
    message: '未配置 Fish 密钥或有效音色，本次继续音乐',
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
  staleJob: () => ({
    segueId: 'sg_demo_3',
    state: 'stale' as const,
    reason: 'transition_closed',
    createdAt: 1726459200000,
    transition: clone(SAMPLE_TEMPLATES.transition),
  }),
}

const SCRIPT_INVALID_TEMPLATES: Record<string, (s: SegueScript) => Record<string, unknown>> = {
  emptyScript: (s) => ({ ...s, scriptText: '   ' }),
  invalidStoryStatus: (s) => ({ ...s, storyStatus: 'rumor' }),
  wrongKind: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, kind: 'rumor' } : c)) }),
  missingSourceReference: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, sourceIds: ['s999'] } : c)) }),
  claimWithoutSource: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, sourceIds: [] } : c)) }),
  missingSpokenAttribution: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '' } : c)) }),
  attributionNotInScript: (s) => ({ ...s, claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '据权威机构证实' } : c)) }),
  basicOnlyWithClaims: () => ({ ...clone(SAMPLE_TEMPLATES.basicOnlyScript), claims: clone(SAMPLE_TEMPLATES.sourcedScript.claims) }),
  basicOnlyWithSources: () => ({ ...clone(SAMPLE_TEMPLATES.basicOnlyScript), sources: clone(SAMPLE_TEMPLATES.sourcedScript.sources) }),
  overlongScript: (s) => ({ ...s, scriptText: '长'.repeat(141), claims: s.claims.map((c, i) => (i === 0 ? { ...c, spokenAttribution: '长' } : c)) }),
  badSourceUrl: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, url: 'ftp://forum.example.com/x' } : x)) }),
  duplicateSourceId: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 1 ? { ...x, id: 's1' } : x)) }),
  evidenceTooLong: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, evidence: '长'.repeat(401) } : x)) }),
  badRetrievedAt: (s) => ({ ...s, sources: s.sources.map((x, i) => (i === 0 ? { ...x, retrievedAt: 'not-a-date' } : x)) }),
  noClaims: (s) => ({ ...s, claims: [] }),
  noSources: (s) => ({ ...s, sources: [] }),
  missingTransitionId: (s) => ({ ...s, transitionId: '' }),
}

export interface InvalidSample {
  name: string
  kind: 'script' | 'prepare' | 'job'
  value: unknown
  expectCode: string
}

function buildInvalidSamples(): InvalidSample[] {
  const sourced = () => clone(SAMPLE_TEMPLATES.sourcedScript)
  const scriptSamples: Array<[string, string, string]> = [
    ['empty_script', 'emptyScript', 'empty_script'],
    ['invalid_story_status', 'invalidStoryStatus', 'invalid_story_status'],
    ['invalid_claim_kind', 'wrongKind', 'invalid_claim_kind'],
    ['missing_source_reference', 'missingSourceReference', 'missing_source_reference'],
    ['claim_without_source', 'claimWithoutSource', 'claim_without_source'],
    ['missing_spoken_attribution', 'missingSpokenAttribution', 'missing_spoken_attribution'],
    ['attribution_missing_in_script', 'attributionNotInScript', 'attribution_missing_in_script'],
    ['basic_only_with_claims', 'basicOnlyWithClaims', 'basic_only_with_claims'],
    ['basic_only_with_sources', 'basicOnlyWithSources', 'basic_only_with_sources'],
    ['script_too_long', 'overlongScript', 'script_too_long'],
    ['invalid_source_url', 'badSourceUrl', 'invalid_source_url'],
    ['duplicate_source_id', 'duplicateSourceId', 'duplicate_source_id'],
    ['evidence_too_long', 'evidenceTooLong', 'evidence_too_long'],
    ['invalid_retrieved_at', 'badRetrievedAt', 'invalid_retrieved_at'],
    ['no_claims', 'noClaims', 'no_claims'],
    ['no_sources', 'noSources', 'no_sources'],
    ['missing_transition_id', 'missingTransitionId', 'missing_transition_id'],
  ]
  const samples: InvalidSample[] = scriptSamples.map(([name, key, expectCode]) => ({
    name,
    kind: 'script',
    value: SCRIPT_INVALID_TEMPLATES[key](sourced()),
    expectCode,
  }))
  const base = SAMPLE_TEMPLATES.prepareRequest
  const prepareSamples: Array<[string, Record<string, unknown>, string]> = [
    ['prepare_missing_session', { sessionId: '' }, 'missing_session_id'],
    ['prepare_missing_transition', { transitionId: '' }, 'missing_transition_id'],
    ['prepare_same_from_target', { targetItemId: base.fromItemId }, 'same_from_and_target'],
    ['prepare_bad_track_id', { targetTrackId: 'x' }, 'invalid_target_track_id'],
    ['prepare_bad_epoch', { epoch: 'nan' }, 'invalid_epoch'],
    ['prepare_brief_too_long', { brief: 'x'.repeat(201) }, 'brief_too_long'],
  ]
  for (const [name, patch, expectCode] of prepareSamples) {
    samples.push({ name, kind: 'prepare', value: { ...clone(base), ...patch }, expectCode })
  }
  const jobSamples: Array<[string, (r: typeof JOB_TEMPLATES) => Record<string, unknown>, string]> = [
    ['job_ready_missing_audio', (r) => ({ ...r.readyJob(), audio: undefined }), 'missing_audio'],
    [
      'job_external_audio_url',
      (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: 'https://cdn.example.com/x.mp3', durationMs: 20000 } }),
      'invalid_audio_url',
    ],
    [
      'job_zero_duration',
      (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 0 } }),
      'invalid_audio_duration',
    ],
    [
      'job_audio_too_long',
      (r) => ({ ...r.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 31000 } }),
      'audio_too_long',
    ],
    [
      'job_premature_result',
      (r) => ({ ...r.preparingJob(), audio: r.readyJob().audio }),
      'premature_result',
    ],
    ['job_bad_unavailable_reason', (r) => ({ ...r.unavailableJob(), reason: 'whatever' }), 'invalid_unavailable_reason'],
    ['job_bad_stale_reason', (r) => ({ ...r.staleJob(), reason: 'whatever' }), 'invalid_stale_reason'],
    ['job_bad_state', (r) => ({ ...r.preparingJob(), state: 'done' }), 'invalid_job_state'],
  ]
  for (const [name, build, expectCode] of jobSamples) {
    samples.push({ name, kind: 'job', value: build(JOB_TEMPLATES), expectCode })
  }
  // 跨目标：稿子为目标 A 生成，却声称属于目标 B 的任务
  const crossTarget = JOB_TEMPLATES.readyJob()
  crossTarget.script.targetTrackId = 777777
  samples.push({ name: 'job_cross_target_script', kind: 'job', value: crossTarget, expectCode: 'target_mismatch' })
  return samples
}

export const SAMPLES = {
  /** 深拷贝取用，避免样例被调用方意外改坏。 */
  track: () => clone(SAMPLE_TEMPLATES.track),
  trackA: () => clone(SAMPLE_TEMPLATES.trackA),
  prepareRequest: () => clone(SAMPLE_TEMPLATES.prepareRequest),
  transition: () => clone(SAMPLE_TEMPLATES.transition),
  sourcedScript: () => clone(SAMPLE_TEMPLATES.sourcedScript),
  basicOnlyScript: () => clone(SAMPLE_TEMPLATES.basicOnlyScript),
  trackItem: () => makeTrackItem(SAMPLE_TEMPLATES.trackA),
  segueItem: () => makeSegueItem(clone(SAMPLE_TEMPLATES.transition)),
  preparingJob: JOB_TEMPLATES.preparingJob,
  readyJob: JOB_TEMPLATES.readyJob,
  unavailableJob: JOB_TEMPLATES.unavailableJob,
  staleJob: JOB_TEMPLATES.staleJob,
  invalidSamples: buildInvalidSamples,
}
