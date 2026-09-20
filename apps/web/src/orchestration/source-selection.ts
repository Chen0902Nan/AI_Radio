import { makeTrackItem, type TrackItem } from '@radio/contracts'
import { api } from '../api/client'
import type { PlaybackController } from '../playback/playback-controller'
import type { RefillController } from './refill-controller'
import type { createAppStore } from './app-store'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 来源异步操作与播放器共用编排版本；组件只提交意图，不持有第二套请求序号。 */
export class SourceSelection {
  constructor(
    private playback: PlaybackController,
    private refill: RefillController,
    private store: ReturnType<typeof createAppStore>,
    private onIntent: (epoch: number) => void,
  ) {}

  selectManual(tracks: TrackItem[], label: string): void {
    this.playback.replaceQueue(tracks.map(t => ({ ...t, auto: false, selectionId: undefined })))
    this.store.set({ queueMode: 'manual', radioPrepared: false, sourceLabel: label })
  }

  async library(signal: AbortSignal) {
    const epoch = this.refill.epoch
    try {
      const data = await api.library()
      if (signal.aborted) return null
      if (!data.ok) throw new Error(data.message || `HTTP ${data.status}`)
      const current = epoch === this.refill.epoch
      if (current) this.initializeQueue(data.liked.tracks.map(t => makeTrackItem(t)))
      return { ...data, current }
    } catch (error) {
      if (!signal.aborted && epoch === this.refill.epoch) this.store.set({ status: { text: '读取音乐资料失败：' + message(error) + '（请先到 /login 扫码）', cls: 'bad' } })
      return null
    }
  }

  private initializeQueue(tracks: TrackItem[]): void {
    if (this.playback.getSnapshot().userWantsPlayback) return
    if (this.store.get().preparingStart || this.playback.queue.length) return
    this.playback.replaceQueue(tracks)
  }

  async playlist(id: number, name: string, signal?: AbortSignal) {
    this.selectManual([], `歌单：${name}`)
    const epoch = this.refill.epoch
    this.store.set({ status: { text: `正在读取歌单「${name}」…`, cls: '' } })
    try {
      const data = await api.playlist(id)
      if (signal?.aborted || epoch !== this.refill.epoch) return null
      if (!data.ok) throw new Error(data.message || `HTTP ${data.status}`)
      this.selectManual(data.tracks.map(t => makeTrackItem(t)), `歌单：${name}`)
      this.store.set({ status: { text: `歌单「${name}」读取到 ${data.returned}/${data.trackCount} 首（${data.via}）。`, cls: 'ok' } })
      return data.tracks
    } catch (error) {
      if (!signal?.aborted && epoch === this.refill.epoch) this.store.set({ status: { text: '读取歌单失败：' + message(error), cls: 'bad' } })
      return null
    }
  }

  async plan(brief: string, signal?: AbortSignal): Promise<{ text: string; cls: string }> {
    const epoch = this.changeIntent('manual_plan')
    const obsolete = () => ({ text: '播放安排已经改变，已忽略旧选歌结果。', cls: '' })
    try {
      const currentId = this.playback.getSnapshot().currentTrackId
      const data = await api.plan({ brief: brief.trim(), count: 5, epoch, sessionId: this.store.get().sessionId, excludeIds: currentId ? [currentId] : [] })
      if (!this.isCurrent(epoch, signal)) return obsolete()
      if (!data.ok) throw new Error(data.message || `HTTP ${data.status}`)
      this.playback.replaceUpcoming(data.picks.map(p => makeTrackItem({ ...p, auto: true, fromCodex: true })))
      this.store.set({ codexPicks: data.picks.map(p => ({ id: p.id, name: p.name, reason: p.reason })), sourceLabel: '混合电台 · 50% 探索', queueMode: 'radio', radioPrepared: true })
      const seconds = data.meta?.durationMs ? (data.meta.durationMs / 1000).toFixed(1) : '?'
      return { text: `${data.message ? data.message + '。' : ''}Codex 选出 ${data.picks.length} 首，已接在当前播放之后（用时 ${seconds}s）。点下面任意一首可直接播放。`, cls: 'ok' }
    } catch (error) {
      if (!this.isCurrent(epoch, signal)) return obsolete()
      return { text: `Codex 选歌失败：${message(error)}。继续使用原队列，播放不受影响。`, cls: 'bad' }
    }
  }

  private isCurrent(epoch: number, signal?: AbortSignal): boolean {
    return !signal?.aborted && epoch === this.refill.epoch
  }

  private changeIntent(reason: string): number {
    const epoch = this.refill.cancel(reason, { reset: true })
    this.onIntent(epoch)
    return epoch
  }

  async playManual(trackId: number): Promise<void> {
    const index = this.playback.queue.findIndex(t => t.trackId === trackId)
    if (index < 0) return
    this.changeIntent('manual_track')
    await this.playback.playManual(index)
  }
}
