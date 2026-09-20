import type { TrackItem } from '@radio/contracts'

export interface PlaybackSnapshot {
  /** 当前条目（歌曲或播报的统一入口身份） */
  currentItemId: string | null
  currentTrackId: number | null
  currentTitle: string | null
  /** 'track' | 'segue' | 'preview'：试听与正式节目共享音频出口但身份独立 */
  currentKind: 'track' | 'segue' | 'preview'
  index: number
  queueLength: number
  loadedTrackId: number | null
  /** 用户当前是否希望出声：加载中暂停后，晚到结果不得把播放拉起来 */
  userWantsPlayback: boolean
  resolving: boolean
  paused: boolean
  currentTime: number
  duration: number
  readyState: number
  playToken: number
  previewing: boolean
  /** 当前媒体归属的播放实例（供调试与测试快照） */
  mediaPlayInstance: string | null
}

export interface PlaybackEvents {
  /** 首次实际出声（同一 playInstanceId 只触发一次）：记录播放记录等 */
  onFirstPlaying?: (item: TrackItem | null, playInstanceId: string) => void
  /** 进入歌曲（含手动选曲/切歌）：串场控制器 onTrackStarted 的通知点 */
  onTrackStarted?: (item: TrackItem, next: TrackItem | null, playInstanceId: string) => void
  /** 手动下一首（不累计）：串场控制器 onSkipped 的通知点 */
  onTrackSkipped?: () => void
  /** 暂停/恢复：串场控制器 onPaused/onResumed 的通知点 */
  onPaused?: () => void
  onResumed?: (userGesture?: boolean) => void
  /** 停止收听：串场控制器 onStopped 的通知点 */
  onStopped?: () => void
  /** 当前歌曲的有效自然结束（已按实例去重） */
  onNaturalEnded?: (item: TrackItem | null, playInstanceId: string) => void
  /** 播放失败（解析失败/媒体错误/浏览器拒绝），带连续失败计数前的语义 */
  onTrackFailed?: (item: TrackItem | null, reason: string) => void
  /** 任意状态变化（供 React 订阅） */
  onChange?: () => void
}

export interface ResolveResult {
  ok: boolean
  playable?: boolean
  audioUrl?: string | null
  code?: string
  message?: string
  status?: number
}

/** 播放器实际需要的媒体边界；真实 HTMLAudioElement 和离线替身均须满足。 */
export interface AudioPort {
  preload: string
  paused: boolean
  currentTime: number
  duration: number
  readyState: number
  src: string
  currentSrc: string
  error: { code: number } | null
  play: () => Promise<void>
  pause: () => void
  removeAttribute: (name: string) => void
  addEventListener: (name: string, listener: () => void) => void
  removeEventListener: (name: string, listener: () => void) => void
}
export type AudioFactory = () => AudioPort


/* PlaybackEvents 里用到但声明在外的补充事件（避免声明块过长拆开阅读） */
export interface PlaybackEvents {
  onUpcomingReplaced?: () => void
  onQueueReplaced?: () => void
  onQueueExhausted?: () => void
  onSeguePlaying?: (segue: { segueId: string }) => void
  onSegueEnded?: (segueId: string) => void
  onSegueFailed?: (segueId: string, started: boolean) => void
  onRefreshAttempt?: (message: string) => void
  onTrackRetrying?: (track: TrackItem, reason: string, attempt: number) => void
  onPreviewFailed?: (message: string) => void
}
