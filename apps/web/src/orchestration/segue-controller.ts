/**
 * 串场机会控制器（TS 迁移自 public/segue-controller.js）：把「何时准备、何时可播、
 * 何时必须作废」收敛为无 DOM、无 audio 的纯逻辑模块。
 *
 * 职责：
 *  - 维护自然结束计数：只在当前歌曲播放实例的有效 ended 上累计一次；
 *    手动下一首、直接选曲、解析/播放失败、DJ 的 ended 均不累计。
 *  - 进入歌曲时，自然完成数达到 djIntervalTracks - 1 且已知紧邻下一首（且可播），
 *    就通过注入的 requestPrepare 提前为「本曲结束 → 下一首开始」的机会准备串场。
 *  - 自然结束时一次性决定：到期 + DJ 就绪 + 目标未变 → play-segue；否则关闭机会继续音乐。
 *  - 机会一旦关闭，所有迟到结果失去排程资格——以 requestId + transitionId 双重核对。
 *  - DJ 首次实际出声（onSeguePlaying）才把计数清零一次；未出声失败/被取消不清零。
 *  - 服务失败进入 60 秒起倍增、15 分钟封顶的有界冷却；配置/认证错误在配置更新前不重复请求。
 *  - 暂停保留在途结果但不出声、不启动新准备；停止清空机会、计数与任务绑定。
 */
import {
  makeTransition,
  closeTransition,
  isTransitionOpen,
  validatePrepareRequest,
  type Transition,
  type TrackItem,
  type SegueScript,
} from '@radio/contracts'

export interface SegueConfig {
  djEnabled: boolean
  djIntervalTracks: number
  brief: string
}

export const SEGUE_DEFAULTS: SegueConfig = { djEnabled: true, djIntervalTracks: 4, brief: '' }
export const INTERVAL_OPTIONS = [3, 4, 5]
export const COOLDOWN_BASE_MS = 60 * 1000
export const COOLDOWN_MAX_MS = 15 * 60 * 1000
/** 配置/认证类失败：不进入时间冷却，而是阻塞到配置更新。 */
export const CONFIG_BLOCK_CODES = ['not_configured', 'auth', 'unknown_model', 'invalid_reference']

export interface SegueDecision {
  type: 'prepare' | 'cancel' | 'play-segue' | 'continue-track' | 'none'
  reason: string
  at: number
  cooldownMs?: number
  segue?: {
    segueId: string
    transitionId: string
    targetItemId: string
    targetTrackId: number
    script: SegueScript
    audio: { assetId: string; url: string; durationMs: number; bytes: number }
  }
  targetItemId?: string
}

interface PendingPrepare {
  requestId: number
  transitionId: string
  targetItemId: string
  state: 'preparing' | 'ready' | 'playing'
  requestedAt: number
  segueId?: string
  ready?: { script: SegueScript; audio: { assetId: string; url: string; durationMs: number; bytes: number } }
}

export interface PrepareRequestPayload {
  sessionId: string | null
  epoch: number
  transitionSeq: number
  transitionId: string
  fromItemId: string
  targetItemId: string
  targetTrackId: number
  targetName: string
  targetArtists: string
  brief: string
}

export class SegueController {
  requestPrepare: (req: PrepareRequestPayload) => Promise<Record<string, unknown>>
  cancelPrepare: (segueId: string, reason: string) => void
  onChange: () => void
  now: () => number
  config: SegueConfig

  private sessionId: string | null = null
  private epoch = 0
  private transitionSeq = 0
  private stopped = true
  private paused = false
  private naturalCount = 0
  private currentItem: TrackItem | null = null
  private nextItem: TrackItem | null = null
  private nextPlayable: boolean | undefined = undefined
  private transition: Transition | null = null
  private pending: PendingPrepare | null = null
  private requestSeq = 0
  private currentPlayInstance: string | null = null
  private lastCountedEndedInstance: string | null = null
  private countResetForSegue: string | null = null
  private consecutiveFailures = 0
  private cooldownUntil = 0
  private blockedReason: string | null = null
  private lastReason: { code: string; message: string } | null = null
  private stats = { prepares: 0, cancels: 0, plays: 0, lateDiscards: 0, failures: 0 }

  constructor(opts: {
    requestPrepare?: (req: PrepareRequestPayload) => Promise<Record<string, unknown>>
    cancelPrepare?: (segueId: string, reason: string) => void
    onChange?: () => void
    now?: () => number
    config?: Partial<SegueConfig>
  } = {}) {
    this.requestPrepare = opts.requestPrepare || (() => Promise.resolve({ state: 'unavailable', code: 'not_configured' }))
    this.cancelPrepare = opts.cancelPrepare || (() => {})
    this.onChange = opts.onChange || (() => {})
    this.now = opts.now || (() => Date.now())
    this.config = { ...SEGUE_DEFAULTS, ...(opts.config || {}) }
  }

  /* ---------- 会话与配置 ---------- */

  /** 开播/重开：清空全部机会状态，从 0 计数。 */
  startSession({ sessionId, epoch = 0, transitionSeq = 0 }: { sessionId?: string | null; epoch?: number; transitionSeq?: number }): Record<string, unknown> {
    this.transitionSeq = sessionId === this.sessionId ? Math.max(this.transitionSeq, transitionSeq) : transitionSeq
    this.sessionId = sessionId || null
    this.epoch = Number(epoch) || 0
    this.stopped = false
    this.paused = false
    this.naturalCount = 0
    this.currentItem = null
    this.nextItem = null
    this.nextPlayable = undefined
    this.transition = null
    this.pending = null
    this.currentPlayInstance = null
    this.lastCountedEndedInstance = null
    this.countResetForSegue = null
    this.lastReason = null
    return this.snapshot()
  }

  /** 切来源/应用新计划/重置节目：机会关闭、在途作废、计数清零。 */
  setEpoch(epoch: number): Record<string, unknown> {
    this.epoch = Number(epoch) || 0
    this._closeGap('epoch_changed', { cancel: true })
    this.naturalCount = 0
    this.currentItem = null
    this.nextItem = null
    this.nextPlayable = undefined
    this.currentPlayInstance = null
    this.lastCountedEndedInstance = null
    return this.snapshot()
  }

  /**
   * 更新设置。改频率/关闭 DJ 只影响之后的准备：未播成品作废，不打断当前歌曲
   * 或已出声的 DJ。voiceConfigUpdated 表示音色/语音配置已更新，解除配置错误阻塞。
   */
  setConfig(partial: Partial<SegueConfig & { voiceConfigUpdated: boolean }> = {}): Record<string, unknown> {
    let changed = false
    if (partial.djEnabled !== undefined) {
      const v = Boolean(partial.djEnabled)
      if (v !== this.config.djEnabled) changed = true
      this.config.djEnabled = v
    }
    if (partial.djIntervalTracks !== undefined) {
      const n = Number(partial.djIntervalTracks)
      if (INTERVAL_OPTIONS.includes(n) && n !== this.config.djIntervalTracks) changed = true
      if (INTERVAL_OPTIONS.includes(n)) this.config.djIntervalTracks = n
    }
    if (partial.brief !== undefined && typeof partial.brief === 'string') {
      this.config.brief = partial.brief.slice(0, 200)
      changed = true
    }
    if (partial.voiceConfigUpdated) {
      this.blockedReason = null
      this.consecutiveFailures = 0
      this.cooldownUntil = 0
      changed = true
    }
    if (changed) {
      // 未播成品作废；已出声的 DJ 由播放层继续播完，这里的计数不受影响
      this._closeGap('config_changed', { cancel: true })
      this._openTransitionIfNeeded()
      this.maybePrepare()
    }
    return this.snapshot()
  }

  /* ---------- 歌曲生命周期 ---------- */

  /**
   * 进入歌曲（含手动选曲/切歌）。item=当前条目，next=紧邻下一首（可为 null）。
   * 隐式取代上一个机会：上一首被跳过或失败恢复后的进入都会走到这里。
   */
  onTrackStarted({ item, next, nextPlayable, playInstanceId, at }: { item?: TrackItem | null; next?: TrackItem | null; nextPlayable?: boolean; playInstanceId?: string; at?: number } = {}): SegueDecision {
    if (this.stopped) return this._decide('none', 'stopped', at)
    this.currentItem = item || null
    this.nextItem = next || null
    this.nextPlayable = nextPlayable
    this.currentPlayInstance = playInstanceId || null
    this.lastCountedEndedInstance = null
    // 上一条机会被隐式取代
    if (this.transition && (!isTransitionOpen(this.transition) || this.transition.fromItemId !== (item && item.itemId))) {
      this._closeGap('superseded', { cancel: true })
    }
    this._openTransitionIfNeeded()
    const prepared = this.maybePrepare()
    return this._decide(prepared ? 'prepare' : 'none', prepared ? 'preparing_next_gap' : 'no_prepare', at)
  }

  /** 解析/播放失败：不累计；机会随失败恢复路径被下一次 onTrackStarted 重建。 */
  onTrackFailed({ item, at }: { item?: TrackItem | null; at?: number } = {}): SegueDecision {
    if (item && this.currentItem && item.itemId !== this.currentItem.itemId) {
      return this._decide('none', 'stale_item', at)
    }
    this._closeGap('track_failed', { cancel: true })
    return this._decide('none', 'track_failed', at)
  }

  /** 队列改变：紧邻下一首被补歌/操作替换时，目标变更的机会随之重建。 */
  onQueueChanged({ next, nextPlayable, at }: { next?: TrackItem | null; nextPlayable?: boolean; at?: number } = {}): SegueDecision {
    if (this.stopped) return this._decide('none', 'stopped', at)
    const targetChanged =
      (next && this.nextItem && next.itemId !== this.nextItem.itemId) ||
      (next && !this.nextItem) ||
      (!next && this.nextItem)
    this.nextItem = next || null
    this.nextPlayable = nextPlayable
    if (targetChanged && this.transition) {
      this._closeGap('target_changed', { cancel: true })
    }
    this._openTransitionIfNeeded()
    const prepared = this.maybePrepare()
    return this._decide(prepared ? 'prepare' : 'none', prepared ? 'preparing_next_gap' : 'no_prepare', at)
  }

  /** 手动下一首：不累计；机会关闭，在途准备尽力取消。 */
  onSkipped({ at }: { at?: number } = {}): SegueDecision {
    this._closeGap('skipped', { cancel: true })
    return this._decide('none', 'skipped', at)
  }

  /** 自然结束：唯一累计点；到期时一次性决定播 DJ 还是继续歌曲。 */
  onTrackEnded({ item, playInstanceId, natural, at }: { item?: TrackItem | null; playInstanceId?: string | null; natural?: boolean; at?: number } = {}): SegueDecision {
    const ignored = this.endedRejection(item, playInstanceId, natural)
    if (ignored) return this._decide('none', ignored, at)
    this.lastCountedEndedInstance = playInstanceId || null
    this.naturalCount += 1

    const due = this.naturalCount >= this.config.djIntervalTracks
    if (this.canPlaySegue(due) && this.pending?.ready && this.nextItem) {
      this.pending!.state = 'playing'
      this.stats.plays += 1
      return this._decide('play-segue', 'ready_and_due', at, {
        segue: {
          segueId: this.pending!.segueId!,
          transitionId: this.transition!.transitionId,
          targetItemId: this.nextItem.itemId,
          targetTrackId: this.nextItem.trackId,
          script: this.pending!.ready.script,
          audio: this.pending!.ready.audio,
        },
      })
    }
    this._closeGap(due ? 'not_ready' : 'interval_not_due', { cancel: false })
    return this._decide('continue-track', due ? 'due_but_not_ready' : 'interval_not_due', at, {
      targetItemId: this.nextItem ? this.nextItem.itemId : undefined,
    })
  }

  private isStalePlayInstance(id: string | null | undefined): boolean {
    return !!id && !!this.currentPlayInstance && id !== this.currentPlayInstance
  }

  private endedRejection(item: TrackItem | null | undefined, playInstanceId: string | null | undefined, natural: boolean | undefined): string | null {
    if (this.stopped) return 'stopped'
    if (natural !== true) return 'not_natural'
    if (this.isStalePlayInstance(playInstanceId)) {
      return 'stale_instance'
    }
    if (playInstanceId && this.lastCountedEndedInstance === playInstanceId) {
      return 'duplicate_ended'
    }
    if (item && this.currentItem && item.itemId !== this.currentItem.itemId) {
      return 'stale_item'
    }
    return null
  }

  private isSegueDue(due: boolean): boolean {
    return this.config.djEnabled && due && !this.paused
  }

  private canPlaySegue(due: boolean): boolean {
    return Boolean(
      this.isSegueDue(due) &&
      this.transition &&
      isTransitionOpen(this.transition) &&
      this.pending &&
      this.pending.state === 'ready' &&
      this.pending.transitionId === this.transition.transitionId &&
      this.nextItem &&
      this.pending.targetItemId === this.nextItem.itemId &&
      this.nextPlayable !== false
    )
  }

  /* ---------- DJ 生命周期 ---------- */

  /** DJ 首次实际出声：清零计数（每个 segueId 只清一次）。 */
  onSeguePlaying({ segueId, at }: { segueId?: string; at?: number } = {}): SegueDecision {
    if (this.pending && segueId && this.pending.segueId === segueId && this.countResetForSegue !== segueId) {
      this.naturalCount = 0
      this.countResetForSegue = segueId
    }
    return this._decide('none', 'segue_playing', at)
  }

  /** DJ 完整结束：进入目标歌曲。 */
  onSegueEnded({ segueId, at }: { segueId?: string; at?: number } = {}): SegueDecision {
    const targetItemId =
      this.pending && this.pending.segueId === segueId ? this.pending.targetItemId : this.nextItem && this.nextItem.itemId || undefined
    this._closeGap('segue_finished', { cancel: false })
    return this._decide('continue-track', 'segue_finished', at, { targetItemId })
  }

  /** DJ 被用户跳过：已出声则本轮已用（计数已清零），未出声则计数保持到期。 */
  onSegueSkipped({ segueId, at }: { segueId?: string; at?: number } = {}): SegueDecision {
    this._closeGap('segue_skipped', { cancel: false })
    return this._decide('none', 'segue_skipped', at)
  }

  /** DJ 失败：started=false 表示从未出声，计数保持到期（下一机会可再准备）。 */
  onSegueFailed({ segueId, started = false, at }: { segueId?: string; started?: boolean; at?: number } = {}): SegueDecision {
    this._closeGap(started ? 'segue_failed_after_start' : 'segue_failed_before_start', { cancel: false })
    return this._decide('continue-track', 'segue_failed', at, {
      targetItemId: this.nextItem ? this.nextItem.itemId : undefined,
    })
  }

  /* ---------- 暂停 / 停止 ---------- */

  onPaused({ at }: { at?: number } = {}): SegueDecision {
    this.paused = true
    return this._decide('none', 'paused', at)
  }

  onResumed({ at }: { at?: number } = {}): SegueDecision {
    this.paused = false
    const prepared = this.maybePrepare()
    return this._decide(prepared ? 'prepare' : 'none', prepared ? 'preparing_next_gap' : 'resumed', at)
  }

  onStopped({ at }: { at?: number } = {}): SegueDecision {
    this.stopped = true
    this.paused = false
    this._closeGap('stopped', { cancel: true })
    this.naturalCount = 0
    this.lastCountedEndedInstance = null
    this.countResetForSegue = null
    return this._decide('none', 'stopped', at)
  }

  /* ---------- 准备 ---------- */

  /** 满足条件就为当前机会发起准备；同一时刻最多一条在途准备。 */
  maybePrepare(): boolean {
    if (this.stopped || this.paused || !this.config.djEnabled) return false
    if (this.blockedReason) return false
    if (this.now() < this.cooldownUntil) return false
    if (!this.transition || !isTransitionOpen(this.transition)) return false
    if (!this.nextItem || this.nextPlayable === false) return false
    if (this.pending) return false
    if (this.naturalCount < this.config.djIntervalTracks - 1) return false

    const req: PrepareRequestPayload = {
      sessionId: this.sessionId,
      epoch: this.epoch,
      transitionId: this.transition.transitionId,
      transitionSeq: this.transition.transitionSeq,
      fromItemId: this.transition.fromItemId,
      targetItemId: this.transition.targetItemId,
      targetTrackId: this.transition.targetTrackId!,
      // 歌名/歌手只来自队列条目：音源接口不返回名称，缺了就没法搜索和写稿
      targetName: this.nextItem.name || '',
      targetArtists: this.nextItem.artists || '',
      brief: this.config.brief || '',
    }
    const v = validatePrepareRequest(req)
    if (!v.ok) {
      this.lastReason = { code: 'invalid_request', message: v.errors.map((e) => e.code).join(',') }
      return false
    }
    const requestId = ++this.requestSeq
    this.pending = {
      requestId,
      transitionId: this.transition.transitionId,
      targetItemId: this.transition.targetItemId,
      state: 'preparing',
      requestedAt: this.now(),
    }
    this.stats.prepares += 1
    let p: Promise<Record<string, unknown>>
    try {
      p = Promise.resolve(this.requestPrepare(req))
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then((res) => this._onPrepareResult(requestId, res || { state: 'unavailable', code: 'error' }))
      .catch((err) =>
        this._onPrepareResult(requestId, {
          state: 'unavailable',
          code: 'network',
          message: String((err && (err as Error).message) || err),
        }),
      )
      .finally(() => this.onChange())
    return true
  }

  /** 准备结果到达：只对「仍在途的同一请求 + 仍打开的同一机会」生效。 */
  private _onPrepareResult(requestId: number, res: Record<string, unknown>): SegueDecision {
    if (!this.pending || this.pending.requestId !== requestId) {
      this.stats.lateDiscards += 1
      return { type: 'none', reason: 'late_result_discarded', at: this.now() }
    }
    const transitionAlive =
      this.transition && isTransitionOpen(this.transition) && this.transition.transitionId === this.pending.transitionId
    if (!transitionAlive) {
      this.pending = null
      this.stats.lateDiscards += 1
      return { type: 'none', reason: 'transition_closed', at: this.now() }
    }
    const state = res.state as string
    if (state === 'ready') {
      if (!res.segueId || !res.script || !res.audio) {
        this.pending = null
        return this._recordFailure({ code: 'invalid_output', message: 'ready 结果缺少成品字段' })
      }
      this.pending.state = 'ready'
      this.pending.segueId = res.segueId as string
      this.pending.ready = { script: res.script as SegueScript, audio: res.audio as { assetId: string; url: string; durationMs: number; bytes: number } }
      this.consecutiveFailures = 0
      this.cooldownUntil = 0
      this.lastReason = null
      return { type: 'none', reason: 'ready', at: this.now() }
    }
    // unavailable / stale / preparing 异常返回
    this.pending = null
    if (state === 'stale') {
      this.lastReason = { code: 'stale', message: (res.reason as string) || '' }
      return { type: 'none', reason: 'stale', at: this.now() }
    }
    return this._recordFailure({ code: (res.code as string) || (res.reason as string) || 'error', message: (res.message as string) || '' })
  }

  private _recordFailure({ code, message }: { code: string; message: string }): SegueDecision {
    this.stats.failures += 1
    this.lastReason = { code, message }
    if (CONFIG_BLOCK_CODES.includes(code)) {
      this.blockedReason = code
      return { type: 'none', reason: 'blocked_by_config', at: this.now() }
    }
    this.consecutiveFailures += 1
    const delay = Math.min(COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1), COOLDOWN_MAX_MS)
    this.cooldownUntil = this.now() + delay
    return { type: 'none', reason: 'cooldown', cooldownMs: delay, at: this.now() }
  }

  /* ---------- 内部 ---------- */

  private _openTransitionIfNeeded(): void {
    if (!this.currentItem || !this.nextItem) return
    if (this.transition && isTransitionOpen(this.transition) && this.transition.targetItemId === this.nextItem.itemId) return
    this.transition = makeTransition({
      sessionId: this.sessionId || '',
      epoch: this.epoch,
      transitionSeq: ++this.transitionSeq,
      fromItemId: this.currentItem.itemId,
      targetItemId: this.nextItem.itemId,
      targetTrackId: this.nextItem.trackId,
    })
  }

  /** 关闭当前机会。cancel=true 时尽力取消在途任务；就绪未播的成品一并作废。 */
  private _closeGap(reason: string, { cancel = false }: { cancel?: boolean } = {}): void {
    if (this.pending) {
      if (cancel && this.pending.segueId) {
        try {
          this.cancelPrepare(this.pending.segueId, reason)
          this.stats.cancels += 1
        } catch (_) {}
      }
      this.pending = null
    }
    if (this.transition) {
      this.transition = closeTransition(this.transition, reason)
    }
  }

  private _decide(type: SegueDecision['type'], reason: string, at?: number, extra: Partial<SegueDecision> = {}): SegueDecision {
    const decision: SegueDecision = { type, reason, at: Number(at) || this.now(), ...extra }
    this.lastReason = { code: reason, message: '' }
    return decision
  }

  /** 供界面与测试读取的状态快照。 */
  snapshot() {
    const now = this.now()
    let state = 'idle'
    if (this.stopped) state = 'stopped'
    else if (this.paused) state = 'paused'
    else if (this.pending) state = this.pending.state === 'preparing' ? 'preparing' : this.pending.state
    return {
      djEnabled: this.config.djEnabled,
      djIntervalTracks: this.config.djIntervalTracks,
      sessionId: this.sessionId,
      epoch: this.epoch,
      transitionSeq: this.transitionSeq,
      naturalCount: this.naturalCount,
      countDue: this.naturalCount >= this.config.djIntervalTracks,
      state,
      transitionId: this.transition && isTransitionOpen(this.transition) ? this.transition.transitionId : null,
      targetItemId: this.nextItem ? this.nextItem.itemId : null,
      targetTrackId: this.nextItem ? this.nextItem.trackId : null,
      segueId: this.pending && this.pending.segueId ? this.pending.segueId : null,
      ready: this.pending && this.pending.state === 'ready' ? this.pending.ready : null,
      paused: this.paused,
      stopped: this.stopped,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
      blockedReason: this.blockedReason,
      lastReason: this.lastReason,
      stats: { ...this.stats },
    }
  }
}
