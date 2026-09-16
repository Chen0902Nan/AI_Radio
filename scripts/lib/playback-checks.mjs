/** 判定相邻浏览器快照是否证明补入歌曲已经开始播放。 */
export function isBatchTrackPlaying(previous, current) {
  const ready = (s) => s && s.autoQueueIds.includes(s.currentId) &&
    s.loadedId === s.currentId && !s.paused && !s.stopped && !s.ended &&
    !s.resolving && s.readyState >= 2 && Number.isFinite(s.currentTime)
  return Boolean(ready(previous) && ready(current) &&
    previous.currentId === current.currentId && current.currentTime > previous.currentTime)
}
