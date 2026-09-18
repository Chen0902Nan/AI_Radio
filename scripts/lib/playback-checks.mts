export interface PlaybackSnapshot {
  currentId: number
  loadedId: number
  currentTime: number
  autoQueueIds: number[]
  paused: boolean
  stopped: boolean
  ended: boolean
  resolving: boolean
  readyState: number
}

/** 判定相邻浏览器快照是否证明补入歌曲已经开始播放。 */
export function isBatchTrackPlaying(previous: PlaybackSnapshot | null | undefined, current: PlaybackSnapshot | null | undefined): boolean {
  const ready = (s: PlaybackSnapshot | null | undefined): s is PlaybackSnapshot => Boolean(s && s.autoQueueIds.includes(s.currentId) &&
    s.loadedId === s.currentId && !s.paused && !s.stopped && !s.ended &&
    !s.resolving && s.readyState >= 2 && Number.isFinite(s.currentTime))
  return ready(previous) && ready(current) && previous.currentId === current.currentId && current.currentTime > previous.currentTime
}

interface MediaSample { src: string; paused: boolean; t: number }
/** 同一音源在两个采样点都应当播放，却没有任何媒体时间推进。 */
export function isPlaybackStalled(previous: MediaSample | null | undefined, current: MediaSample | null | undefined): boolean {
  return Boolean(previous && current && previous.src && previous.src === current.src &&
    !previous.paused && !current.paused && Number.isFinite(previous.t) && Number.isFinite(current.t) &&
    Math.abs(current.t - previous.t) < 0.05)
}
