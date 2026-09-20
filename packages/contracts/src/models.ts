import { result } from './validation-utils.js'
import { makeTrackItem } from './identity.js'

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
  transitionSeq: number
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
  transitionSeq: number
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
