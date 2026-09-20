/**
 * 独立 TS PlaybackController（M3，迁移自 public/app.js 的媒体执行与状态部分）。
 *
 * 职责边界（对齐实施文档 §5.1 行为合同）：
 *  - 单一 audio 元素；一个应用实例只有一个控制器，以 dispose 管理生命周期。
 *  - playToken 播放代次：每次新的播放/暂停/切歌意图自增；迟到的解析/播放结果按代次丢弃。
 *  - 媒体归属：mediaPlayInstance 记录「媒体里实际装的是哪次播放实例」，
 *    旧媒体的 playing/ended/error 不能记到新播放实例（同曲重播也能区分）。
 *  - playInstanceId 由 @radio/contracts 的 createPlayInstanceTracker 登记：
 *    暂停恢复复用，重新开始同一条目则新建。
 *  - 暂停后的迟到结果可以保留但不自动出声；加载中暂停取消在途解析。
 *  - 本控制器不渲染：React 通过订阅快照（useSyncExternalStore）读取状态、发命令。
 */
import {
  createPlayInstanceTracker,
  type TrackItem,
  type PlayInstanceTracker,
} from '@radio/contracts'

import type { AudioPort, PlaybackSnapshot, PlaybackEvents, ResolveResult } from './playback-types'
export type { AudioPort, AudioFactory, PlaybackSnapshot, PlaybackEvents, ResolveResult } from './playback-types'
import { PlaybackObservation, snapshotOf, loadedTrackId } from './playback-snapshot'
import { PlaybackRetry } from './playback-retry'
import { resolveSource } from './track-source'

export class PlaybackController {
  private audio: AudioPort
  private tracker: PlayInstanceTracker
  private readonly observation = new PlaybackObservation(() => this.captureSnapshot())
  private readonly retry = new PlaybackRetry()

  private _playToken = 0
  private _userWantsPlayback = false
  private _mediaPlayInstance: string | null = null
  private _resolving = false
  private _previewing = false
  private _current: TrackItem | null = null
  private _currentKind: 'track' | 'segue' | 'preview' = 'track'
  private _index = -1
  private _queue: TrackItem[] = []
  private _refreshedCurrent = false
  private _sessionStopped = false
  private _atEnd = false

  // 注入：解析音源与换歌节奏由外部决定（队列策略属于 orchestration 层）
  resolveTrack: (id: number, force?: boolean) => Promise<ResolveResult> = async () => ({ ok: false, code: 'not_configured' })
  /** 单曲失败后的换歌节奏（旧实现：1.2s 后自动下一首）；返回是否真的发起 */
  retryAfterFailure: (failedIndex: number) => void = (failedIndex) => {
    const token = this._playToken
    this.retry.schedule(() => {
      if (token !== this._playToken || !this._userWantsPlayback) return
      if (failedIndex + 1 < this._queue.length) void this.play(failedIndex + 1)
      else this.events.onQueueExhausted?.()
    })
  }
  /** 连续失败上限（旧实现 3 首） */
  maxConsecutiveFailures = 3
  onConsecutiveFailuresExceeded: (() => void) | null = null

  events: PlaybackEvents

  constructor(opts: { audio?: AudioPort; events?: PlaybackEvents } = {}) {
    this.audio = opts.audio ?? new Audio()
    this.audio.preload = 'none'
    this.tracker = createPlayInstanceTracker()
    this.events = opts.events || {}
    this.bindMediaEvents()
  }

  /* ---------- 订阅（React useSyncExternalStore） ---------- */

  subscribe = this.observation.subscribe
  getSnapshot = this.observation.getSnapshot

  private notify(): void {
    this.observation.sample()
    this.events.onChange?.()
    this.observation.publish()
  }

  /** 仅 notify 时采样媒体；React 读取缓存，避免同一渲染期间引用变化。 */
  private captureSnapshot(): PlaybackSnapshot {
    return snapshotOf(this.audio, {
      currentItemId: this._current?.itemId ?? null,
      currentTrackId: this._current?.trackId ?? null,
      currentTitle: this._current?.name ?? null,
      currentKind: this._currentKind,
      index: this._index,
      queueLength: this._queue.length,
      userWantsPlayback: this._userWantsPlayback,
      resolving: this._resolving,
      playToken: this._playToken,
      previewing: this._previewing,
      mediaPlayInstance: this._mediaPlayInstance,
    })
  }

  get queue(): readonly Readonly<TrackItem>[] {
    return this._queue
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures
  }

  private _consecutiveFailures = 0

  /* ---------- 媒体事件（按当前媒体身份分派） ---------- */

  private bindMediaEvents(): void {
    this.audio.addEventListener('playing', this.handlePlaying)
    this.audio.addEventListener('ended', this.handleEnded)
    this.audio.addEventListener('error', this.handleError)
    this.audio.addEventListener('timeupdate', this.handleTimeUpdate)
    this.audio.addEventListener('pause', this.handlePause)
  }

  /** 当前媒体里装的是不是界面认定的那条内容（旧 mediaOwnsCurrent 语义）。 */
  private mediaOwnsCurrent(): boolean {
    const src = this.audio.currentSrc || this.audio.src || ''
    if (this._currentKind === 'preview') return this._previewing && src.includes('/api/dj/audio/')
    if (this._currentKind === 'segue') {
      return Boolean(this.segue && src.includes(this.segue.audio.url))
    }
    if (this._current === null || this.loadedTrackId() !== this._current.trackId) return false
    return this._mediaPlayInstance !== null && this._mediaPlayInstance === this.tracker.current(this._current.itemId)
  }

  /** 媒体里实际装着哪首歌（切歌解析期间可能还是上一首）。 */
  private loadedTrackId(): number | null {
    return loadedTrackId(this.audio)
  }

  private handlePlaying = (): void => {
    if (this._previewing) {
      this.notify()
      return
    }
    // 出声事件属于实际装载的播放实例，不能替仍在解析的新条目记账
    if (!this.mediaOwnsCurrent()) return
    if (this._currentKind === 'segue' && this.segue) {
      const first = this.tracker.markPlaying(this.tracker.current(`sg:${this.segue.segueId}`))
      if (first) this._segueStarted = true
      this.events.onSeguePlaying?.(this.segue)
      this.notify()
      return
    }
    this._consecutiveFailures = 0
    const pi = this.tracker.current(this._current?.itemId ?? null)
    const firstPlaying = this.tracker.markPlaying(pi)
    this.notify()
    if (firstPlaying && pi) this.events.onFirstPlaying?.(this._current, pi)
  }

  private handleEnded = (): void => {
    if (this._previewing) {
      this._previewing = false
      this.notify()
      return
    }
    if (!this.mediaOwnsCurrent()) {
      // 旧媒体的遗留 ended：不算任何自然结束
      return
    }
    if (this._currentKind === 'segue' && this.segue) {
      const sg = this.segue
      this.tracker.markEnded(this.tracker.current(`sg:${sg.segueId}`))
      this.segue = null
      this._currentKind = 'track'
      this.events.onSegueEnded?.(sg.segueId)
      this.notify()
      return
    }
    const item = this._current
    const pi = this.tracker.current(item?.itemId ?? null)
    const validEnd = this.tracker.markEnded(pi)
    if (validEnd) this._atEnd = true
    this.notify()
    if (validEnd && pi) this.events.onNaturalEnded?.(item, pi)
  }

  private handleError = (): void => {
    if (this._previewing) {
      this._previewing = false
      this.events.onPreviewFailed?.('媒体错误')
      this.notify()
      return
    }
    if (!this.mediaOwnsCurrent()) return
    if (this._currentKind === 'segue' && this.segue) {
      const sg = this.segue
      const started = this._segueStarted
      this.tracker.markEnded(this.tracker.current(`sg:${sg.segueId}`))
      this.segue = null
      this._currentKind = 'track'
      this.events.onSegueFailed?.(sg.segueId, started)
      this.notify()
      return
    }
    if (!this._current) return
    const err = this.audio.error
    const msg = err ? `媒体错误 code=${err.code}` : '媒体错误'
    if (!this._refreshedCurrent) {
      this._refreshedCurrent = true
      this.events.onRefreshAttempt?.(msg)
      void this.refreshCurrent()
      return
    }
    if (!this._userWantsPlayback) {
      // 用户已经暂停/停止：这不算「播放中断」，不记账不自动换歌
      this.notify()
      return
    }
    this.failTrack(this._current, '播放地址失效且刷新后仍失败')
  }

  private handleTimeUpdate = (): void => {
    this.notify()
  }

  private handlePause = (): void => {
    this.notify()
  }

  /* ---------- 队列与来源 ---------- */

  /** 切来源：作废一切在途播放意图并整队替换（新编排意图）。 */
  replaceQueue(tracks: TrackItem[]): void {
    this._playToken += 1
    this._userWantsPlayback = false
    this._resolving = false
    if (!this.audio.paused) this.audio.pause()
    this._queue = [...tracks]
    this._index = -1
    this._current = null
    this._consecutiveFailures = 0
    this._currentKind = 'track'
    this.segue = null
    this.events.onQueueReplaced?.()
    this.notify()
  }

  itemAt(index: number): TrackItem | null {
    return this._queue[index] ?? null
  }

  /** 追加待播条目不改变媒体、当前位置或用户播放意图。 */
  appendQueue(tracks: TrackItem[]): void {
    this._queue.push(...tracks)
    this.notify()
  }

  /** 新计划只替换尚未播放的部分，当前媒体及暂停意图保持不变。 */
  replaceUpcoming(tracks: TrackItem[]): void {
    this._queue = [...this._queue.slice(0, this._index + 1), ...tracks]
    this.events.onUpcomingReplaced?.()
    this.notify()
  }

  /* ---------- 播放命令 ---------- */

  /** 播放指定条目；userGesture 标记用户主动动作（解锁自动出声、重置失败计数）。 */
  /** 手动点歌的记账属性由队列所有者修改，视图不能直接改条目。 */
  async playManual(index: number): Promise<void> {
    const item = this._queue[index]
    if (!item) return
    this._queue[index] = { ...item, auto: false, selectionId: undefined }
    await this.play(index, { userGesture: true })
  }

  async play(index: number, { userGesture = false } = {}): Promise<void> {
    if (index < 0 || index >= this._queue.length) {
      this._userWantsPlayback = false
      this.notify()
      return
    }
    if (userGesture) {
      this._consecutiveFailures = 0
    }

    const track = this._queue[index]
    this._atEnd = false
    this._sessionStopped = false
    if (track && track.type !== 'track') {
      // 队列里不该出现的类型：明确跳过而不是假装能播
      this._index = index
      return this.play(index + 1, { userGesture: true })
    }

    const { token, playInstance } = this.beginTrack(track, index, userGesture)
    await this.resolveAndPlay(track, token, playInstance)
  }

  private beginTrack(track: TrackItem, index: number, userGesture: boolean): { token: number; playInstance: string } {
    // 接下来媒体要装歌曲内容：退出试听态，否则这首歌会被当成试听
    // （不记历史、结束不接下一首）
    this._previewing = false

    // 取代次号；并发切歌时只有最后一次意图对应的结果允许生效
    const token = ++this._playToken
    this._userWantsPlayback = true
    this._resolving = true
    this._index = index
    this._current = track
    this._currentKind = 'track'
    this._refreshedCurrent = false
    this.notify()

    // 进入歌曲：登记播放实例（暂停恢复复用、重开新建由 tracker 保证）
    const playInstance = this.tracker.begin(track.itemId)
    this.notify()
    this.events.onTrackStarted?.(track, this._queue[index + 1] ?? null, playInstance)
    // 用户点歌/点下一首同样是「恢复收听」：控制器必须解除暂停
    this.events.onResumed?.(userGesture)

    return { token, playInstance }
  }

  private async resolveAndPlay(track: TrackItem, token: number, playInstance: string): Promise<void> {
    const source = await resolveSource(() => this.resolveTrack(track.trackId))

    // 解析期间用户又切了歌或点了暂停：丢弃过期结果，不碰播放器
    if (token !== this._playToken || !this._userWantsPlayback) {
      if (token === this._playToken) this._resolving = false
      this.notify()
      return
    }
    this._resolving = false

    if (!source.ok) {
      this.failTrack(track, source.reason)
      return
    }

    this.audio.src = source.audioUrl + '?t=' + Date.now()
    // 媒体里装的就是这次播放实例的音频，后续事件按这个实例归属
    this._mediaPlayInstance = playInstance
    try {
      await this.audio.play()
      // 旧 play() 完成不能再操作唯一音频出口；新意图已负责暂停或换曲。
      if (token !== this._playToken) return
    } catch (err) {
      if (token !== this._playToken) return
      // 浏览器拦截自动播放或加载失败：按单曲失败处理
      this.failTrack(track, '浏览器拒绝播放：' + (err as Error).message)
    }
  }

  /** 暂停：代次自增 = 作废所有在途解析（「加载中暂停」不被覆盖的关键）。 */
  pause(): void {
    this._playToken += 1
    this._userWantsPlayback = false
    this._resolving = false
    if (!this.audio.paused) this.audio.pause()
    // 暂停可保留在途串场结果，但不启动新准备、不让结果出声
    this.events.onPaused?.()
    this.notify()
  }

  /**
   * 继续播放：只有「媒体里已装载的就是当前条目」时才允许直接续播，
   * 否则（切歌加载中暂停过）重新走 play() 完整流程。
   */
  async resume(): Promise<void> {
    if (this._currentKind === 'segue' && this.segue && !this._sessionStopped) return this.resumeSegue()
    if (this._atEnd) {
      if (this.itemAt(this._index + 1)) return this.play(this._index + 1, { userGesture: true })
      this._userWantsPlayback = true
      this.events.onResumed?.(true)
      this.events.onQueueExhausted?.()
      this.notify()
      return
    }
    const track = this._current
    if (track && this.canResumeTrack(track)) return this.resumeTrack(track)
    await this.play(Math.max(this._index, 0), { userGesture: true })
  }

  private canResumeTrack(track: TrackItem): boolean {
    return this.loadedTrackId() === track.trackId && this.audio.currentTime > 0 && this._currentKind === 'track'
  }

  private async resumeSegue(): Promise<void> {
    const token = ++this._playToken
    this._userWantsPlayback = true
    this.notify()
    this.events.onResumed?.(true)
    try { await this.audio.play() }
    catch {
      if (token !== this._playToken || !this.segue) return
      const failed = this.segue
      this.segue = null
      this._currentKind = 'track'
      this.events.onSegueFailed?.(failed.segueId, this._segueStarted)
      this.notify()
    }
  }

  private ownsTrackOperation(token: number, track: TrackItem): boolean {
    return token === this._playToken && this._current === track
  }

  private async resumeTrack(track: TrackItem): Promise<void> {
    const token = ++this._playToken
    this._userWantsPlayback = true
    const newSession = this._sessionStopped
    const pi = newSession ? this.tracker.begin(track.itemId) : this._mediaPlayInstance ?? this.tracker.begin(track.itemId)
    if (newSession || !this._mediaPlayInstance) this._mediaPlayInstance = pi
    else this.tracker.resume(track.itemId)
    this._sessionStopped = false
    if (newSession) this.events.onTrackStarted?.(track, this.itemAt(this._index + 1), pi)
    this.notify()
    this.events.onResumed?.(true)
    try {
      await this.audio.play()
      if (!this.ownsTrackOperation(token, track)) return
    } catch (error) {
      if (!this.ownsTrackOperation(token, track)) return
      this.events.onTrackFailed?.(track, '浏览器拒绝播放：' + (error as Error).message)
    }
  }

  /** 停止收听：暂停媒体、作废播放意图，并通知串场控制器清空机会与计数。 */
  stop(): void {
    this._sessionStopped = true
    this._playToken += 1
    this._userWantsPlayback = false
    this._resolving = false
    if (!this.audio.paused) this.audio.pause()
    this.events.onStopped?.()
    this.notify()
  }

  /** 手动下一首：先关闭当前串场机会（不累计），再播放目标位置。 */
  async skipTo(index: number): Promise<void> {
    this.events.onTrackSkipped?.()
    // 串场播放中点下一首：结束播报并播放它后面的那首歌（旧 next() Q3 语义）
    if (this._currentKind === 'segue' && this.segue) {
      const sg = this.segue
      if (!this.audio.paused) this.audio.pause()
      this.tracker.markEnded(this.tracker.current(`sg:${sg.segueId}`))
      this.segue = null
      this._currentKind = 'track'
      this.notify()
    }
    if (index >= this._queue.length) {
      this._playToken += 1
      this._atEnd = true
      this._userWantsPlayback = true
      this._resolving = false
      this.audio.pause()
      this.tracker.markEnded(this.tracker.current(this._current?.itemId ?? null))
      this.events.onResumed?.(true)
      this.events.onQueueExhausted?.()
      this.notify()
      return
    }
    await this.play(index, { userGesture: true })
  }

  /* ---------- 失败恢复 ---------- */

  private failTrack(track: TrackItem, reason: string): void {
    // 切歌时旧音频还在响；解析失败必须停掉它
    this.audio.pause()
    this._resolving = false
    this._consecutiveFailures += 1
    this.events.onTrackFailed?.(track, reason)

    if (this._consecutiveFailures >= this.maxConsecutiveFailures) {
      this._userWantsPlayback = false
      this.onConsecutiveFailuresExceeded?.()
      this.notify()
      return
    }
    this.events.onTrackRetrying?.(track, reason, this._consecutiveFailures)
    // 换歌节奏由外部决定（orchestration 层注入），这里只负责作废旧媒体
    this.retryAfterFailure(this._index)
    this.notify()
  }

  /** 播放中断后刷新地址（恢复出声或静默换好地址等用户继续）。 */
  async refreshCurrent(): Promise<void> {
    const track = this._current
    if (!track) return
    const token = this._playToken
    try {
      const r = await this.resolveTrack(track.trackId, true)
      if (token !== this._playToken) return
      if (!r.ok || !r.playable) throw new Error(r.message || '刷新未取得可用地址')
      this.audio.src = r.audioUrl! + '?t=' + Date.now()
      if (!this._userWantsPlayback) {
        // 刷新地址是为了能继续听，不是为了自动出声
        this.notify()
        return
      }
      await this.audio.play()
    } catch (err) {
      if (token !== this._playToken) return
      if (!this._userWantsPlayback) {
        this.notify()
        return
      }
      this.failTrack(track, '刷新地址失败：' + (err as Error).message)
    }
  }

  /* ---------- DJ 串场与试听（共享唯一音频出口） ---------- */

  private segue: { segueId: string; audio: { url: string; durationMs: number } } | null = null
  private _segueStarted = false

  /** 播出已就绪的串场成品（同一 audio 出口，身份独立于歌曲）。 */
  async playSegue(segue: { segueId: string; audio: { url: string; durationMs: number }; script: { targetName?: string; targetArtists?: string } }): Promise<void> {
    this.tracker.begin(`sg:${segue.segueId}`) // 作废上一个实例
    const token = ++this._playToken
    this._currentKind = 'segue'
    this.segue = segue
    this._segueStarted = false
    this._resolving = false
    this.audio.src = segue.audio.url + '?t=' + Date.now()
    this.notify()
    try {
      await this.audio.play()
      if (token !== this._playToken) return
    } catch (_) {
      if (token !== this._playToken) return
      // 从未出声：本轮机会不算使用
      this.segue = null
      this._currentKind = 'track'
      this.events.onSegueFailed?.(segue.segueId, false)
      this.notify()
    }
  }

  /** 停止收听时的主动试听：不进队列、不记历史、不改计数。 */
  async startPreview(audioUrl: string): Promise<boolean> {
    const token = ++this._playToken
    this._previewing = true
    this.audio.src = audioUrl + '?t=' + Date.now()
    this.notify()
    try {
      await this.audio.play()
      if (token !== this._playToken) return false
      return true
    } catch (err) {
      if (token !== this._playToken) return false
      this._previewing = false
      this.events.onPreviewFailed?.((err as Error).message)
      this.notify()
      return false
    }
  }

  /** 开播/停止/再次试听会作废在途试听。 */
  cancelPreview(): void {
    if (!this._previewing) return
    this._playToken += 1
    this._previewing = false
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.notify()
  }

  /* ---------- 生命周期 ---------- */

  /** 释放媒体与监听；一个应用实例只有一个控制器，卸载即 dispose。 */
  dispose(): void {
    this.audio.removeEventListener('playing', this.handlePlaying)
    this.audio.removeEventListener('ended', this.handleEnded)
    this.audio.removeEventListener('error', this.handleError)
    this.audio.removeEventListener('timeupdate', this.handleTimeUpdate)
    this.audio.removeEventListener('pause', this.handlePause)
    if (!this.audio.paused) this.audio.pause()
    this.audio.removeAttribute('src')
    this.retry.cancel()
    this.observation.clear()
  }
}
