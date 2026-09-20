import type { AudioPort, PlaybackSnapshot } from './playback-types'

/** React 订阅快照仅在字段发生变化时换引用；媒体采样仍由唯一控制器触发。 */
export function cacheSnapshot(previous: PlaybackSnapshot | null, next: PlaybackSnapshot): PlaybackSnapshot {
  if (!previous) return next
  // Object.keys 来自已构造的 PlaybackSnapshot，不是外部输入。
  const keys = Object.keys(next) as Array<keyof PlaybackSnapshot>
  return keys.every(key => previous[key] === next[key]) ? previous : next
}
export function loadedTrackId(audio: Pick<AudioPort, 'currentSrc' | 'src'>): number | null {
  const src = audio.currentSrc || audio.src || ''
  if (src.includes('/api/dj/audio/')) return null
  const match = src.match(/\/api\/audio\/(\d+)/)
  return match ? Number(match[1]) : null
}

type LogicalSnapshot = Omit<PlaybackSnapshot, 'loadedTrackId' | 'paused' | 'currentTime' | 'duration' | 'readyState'>
export function snapshotOf(audio: AudioPort, logical: LogicalSnapshot): PlaybackSnapshot {
  return { ...logical, loadedTrackId: loadedTrackId(audio), paused: audio.paused,
    currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState }
}
/** 管理只读订阅与缓存；不执行任何媒体命令或改变播放意图。 */
export class PlaybackObservation {
  private snapshot: PlaybackSnapshot | null = null
  private listeners = new Set<() => void>()
  constructor(private readonly capture: () => PlaybackSnapshot) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): PlaybackSnapshot => this.snapshot ?? this.sample()
  sample(): PlaybackSnapshot {
    this.snapshot = cacheSnapshot(this.snapshot, this.capture())
    return this.snapshot
  }
  publish(): void { for (const listener of this.listeners) listener() }
  clear(): void { this.listeners.clear() }
}
