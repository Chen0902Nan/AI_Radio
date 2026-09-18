/**
 * 后台补歌控制器（TS 迁移自 public/orchestrator.js，与 DOM/音频解耦）。
 *
 * 职责边界：
 *  - 决定「什么时候该准备下一批」：待播数量降到阈值以下、且用户正在收听、且没有在途任务。
 *  - 保证「不重复生成多批」：同一时刻只允许一个在途请求。
 *  - 保证「新意图作废旧结果」：epoch 变化后，迟到的结果一律丢弃。
 *  - 失败退避：指数退避 + 上限次数，超过上限进入等待恢复（需要用户动作才再试）。
 *  - 只把结果交给外部（onBatch）去「追加」，从不替换队列、从不直接出声。
 */
import type { TrackItem } from '@radio/contracts'

export interface RefillContext {
  sessionId: string | null
  playing: boolean
  stopped: boolean
  pending: number
  brief?: string
}

export interface RefillConfig {
  threshold: number
  batchSize: number
  backoffBaseMs: number
  backoffMaxMs: number
  maxAttempts: number
}

export const REFILL_DEFAULTS: RefillConfig = {
  threshold: 2, // 待播剩多少首触发补歌
  batchSize: 5, // 请求补多少首
  backoffBaseMs: 30000, // 失败退避起点
  backoffMaxMs: 300000, // 退避上限
  maxAttempts: 5, // 同一轮最多自动重试几次
}

const REASON_LABEL: Record<string, string> = {
  candidates_exhausted: '候选不足',
  no_playable: '没有可完整播放的候选',
  music_unavailable: '音乐服务暂时不可用',
  library_unavailable: '读取曲库失败',
  timeout: 'Codex 超时',
  quota: 'Codex 额度受限',
  invalid_output: 'Codex 输出无效',
  network: '网络请求失败',
  internal_error: '服务内部错误',
  not_logged_in: '登录已失效',
  no_new_tracks: '补歌结果与待播重复',
}
export const labelFor = (code?: string): string => REASON_LABEL[code || ''] || code || '未知原因'

export interface RefillBatchRequest {
  epoch: number
  excludeIds: number[]
  brief: string
  pending: number
  sessionId: string | null
}

export type RefillBatchResult = Record<string, unknown>

export class RefillController {
  requestBatch: (req: RefillBatchRequest) => Promise<RefillBatchResult>
  getContext: () => RefillContext
  getExclusion: () => number[]
  onBatch: (picks: Array<Record<string, unknown>>, res: RefillBatchResult) => unknown
  onStatus: (text: string, cls: string) => void
  onChange: () => void
  now: () => number
  setTimeoutFn: (fn: () => void, ms: number) => unknown
  clearTimeoutFn: (t: unknown) => void
  config: RefillConfig

  epoch: number
  inFlight = false
  attempts = 0
  nextRetryAt = 0
  state: 'idle' | 'preparing' | 'backoff' | 'waiting_recovery' = 'idle'
  lastReason: { code: string; message: string } | null = null
  timer: unknown = null
  batches = 0
  degradedBatches = 0
  awaiting = false // 队列播完、正在等这一批
  lastBatchAt: number | null = null
  sessionEnded = false // 服务端会话已失效，等待客户端拿到新会话
  recheckAfterFlight = false // 在途期间换了会话，结束后需要再评估一次

  constructor(opts: {
    requestBatch?: (req: RefillBatchRequest) => Promise<RefillBatchResult>
    getContext?: () => RefillContext
    getExclusion?: () => number[]
    onBatch?: (picks: Array<Record<string, unknown>>, res: RefillBatchResult) => unknown
    onStatus?: (text: string, cls: string) => void
    onChange?: () => void
    now?: () => number
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (t: unknown) => void
    config?: Partial<RefillConfig>
    initialEpoch?: number
  } = {}) {
    this.requestBatch = opts.requestBatch || (() => Promise.resolve({ ok: false, code: 'not_configured' }))
    this.getContext = opts.getContext || (() => ({ sessionId: null, playing: false, stopped: false, pending: 0 }))
    this.getExclusion = opts.getExclusion || (() => [])
    this.onBatch = opts.onBatch || (() => {})
    this.onStatus = opts.onStatus || (() => {})
    this.onChange = opts.onChange || (() => {})
    this.now = opts.now || (() => Date.now())
    this.setTimeoutFn = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = opts.clearTimeout || ((t) => clearTimeout(t as NodeJS.Timeout))
    this.config = { ...REFILL_DEFAULTS, ...(opts.config || {}) }

    this.epoch = opts.initialEpoch !== undefined ? Number(opts.initialEpoch) || 0 : Date.now()
  }

  setConfig(partial: Record<string, unknown> = {}): RefillConfig {
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) continue
      ;(this.config as unknown as Record<string, number>)[k] = Number(v)
    }
    return { ...this.config }
  }

  snapshot(): Record<string, unknown> {
    return {
      epoch: this.epoch,
      inFlight: this.inFlight,
      attempts: this.attempts,
      state: this.state,
      nextRetryAt: this.nextRetryAt,
      lastReason: this.lastReason,
      batches: this.batches,
      degradedBatches: this.degradedBatches,
      awaiting: this.awaiting,
      config: { ...this.config },
    }
  }

  isPreparing(): boolean {
    return this.inFlight
  }

  /** 队列播完时是否还值得等一等（在途/退避中），还是已经卡死在等待恢复。 */
  canWaitAtEnd(): boolean {
    return this.state !== 'waiting_recovery'
  }

  markAwaiting(): void {
    this.awaiting = true
  }

  clearAwaiting(): void {
    this.awaiting = false
  }

  /** 用户动作（播放/下一首）后允许从「等待恢复」重新尝试。 */
  resume(): boolean {
    this.sessionEnded = false
    if (this.state !== 'waiting_recovery') return false
    this.attempts = 0
    this.nextRetryAt = 0
    this.state = 'idle'
    this.lastReason = null
    this.onStatus('已重新尝试后台补歌。', 'prep')
    this.onChange()
    return true
  }

  /** 客户端确认/新建了收听会话后调用：清掉「会话失效」标记并重新评估。 */
  sessionReady(): boolean {
    this.sessionEnded = false
    if (this.inFlight) {
      this.recheckAfterFlight = true
      return false
    }
    return this.check()
  }

  /** 作废在途结果并停止计时（停止收听、切换来源、应用新一批时调用）。 */
  cancel(reason = 'cancelled', { reset = false } = {}): number {
    this.epoch += 1
    this.inFlight = false
    this.awaiting = false
    this.sessionEnded = false
    this.recheckAfterFlight = false
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    if (reset) {
      this.attempts = 0
      this.nextRetryAt = 0
      this.lastReason = null
    }
    this.state = 'idle'
    this.onChange()
    return this.epoch
  }

  private scheduleTimer(): void {
    if (this.timer) return
    const wait = Math.max(0, this.nextRetryAt - this.now())
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      this.check({ force: true })
    }, wait)
  }

  /** 队列或播放状态变化后调用；满足条件才真的发起补歌。 */
  check({ force = false } = {}): boolean {
    const ctx = this.getContext() || ({ sessionId: null, playing: false, stopped: false, pending: 0 } as RefillContext)
    if (!ctx.sessionId || !ctx.playing || ctx.stopped) return false
    if (this.sessionEnded) return false
    if (this.inFlight) return false
    if ((Number(ctx.pending) || 0) > this.config.threshold) return false
    if (this.state === 'waiting_recovery') return false
    if (this.now() < this.nextRetryAt) {
      this.scheduleTimer()
      return false
    }
    this.start()
    return true
  }

  private start(): void {
    this.inFlight = true
    this.state = 'preparing'
    this.onChange()
    this.onStatus('后台准备下一批歌曲…', 'prep')

    const epoch = this.epoch
    const excludeIds = this.getExclusion() || []
    const ctx = this.getContext() || ({} as RefillContext)
    const requestSessionId = ctx.sessionId

    Promise.resolve()
      .then(() => {
        // 本地已被取消/取代：不要把过期请求发出去，
        // 否则服务端虽然会拒绝它，白出的请求也可能打扰同会话里更新的编排意图。
        if (epoch !== this.epoch) return null
        return this.requestBatch({
          epoch,
          excludeIds,
          brief: ctx.brief || '',
          pending: Number(ctx.pending) || 0,
          sessionId: requestSessionId,
        })
      })
      .then((res) => {
        if (res === null) return
        this.handleResult(epoch, res, requestSessionId)
      })
      .catch((err) =>
        this.handleResult(epoch, { ok: false, code: 'network', message: String((err && (err as Error).message) || err) }, requestSessionId),
      )
      .finally(() => {
        if (epoch === this.epoch) {
          this.inFlight = false
          if (this.state === 'preparing') this.state = 'idle'
          this.onChange()
          if (this.recheckAfterFlight) {
            this.recheckAfterFlight = false
            this.check()
          }
        }
      })
  }

  private handleResult(epoch: number, res: RefillBatchResult, requestSessionId: string | null): void {
    if (epoch !== this.epoch) return // 过期结果：直接丢弃，绝不落到队列上
    res = res || {}
    if ((res as { code?: string }).code === 'superseded') {
      this.state = 'idle'
      return
    }
    if (res.ok) {
      const picks = (Array.isArray(res.picks) ? res.picks : []) as Array<Record<string, unknown>>
      const added = this.onBatch(picks, res)
      const addedCount = Array.isArray(added) ? added.length : Number(added)
      if (picks.length === 0 || addedCount === 0) {
        // 服务端说成功、但实际一首都没追加（例如与本地待播/失败曲目完全重复）：
        // 必须按失败走退避，不能假装补充成功，更不能在这里跳到队尾继续播。
        this.fail({
          code: 'no_new_tracks',
          message:
            picks.length === 0
              ? '补歌返回了空批次'
              : `补歌返回的 ${picks.length} 首都与当前待播/失败曲目重复，实际追加 0 首`,
        })
        return
      }
      this.attempts = 0
      this.nextRetryAt = 0
      this.state = 'idle'
      this.lastReason = null
      this.batches += 1
      this.lastBatchAt = this.now()
      if (res.degraded) this.degradedBatches += 1
      this.onStatus(res.message ? String(res.message) : `已补充 ${addedCount} 首歌曲`, res.degraded ? 'warn' : 'ok')
      return
    }
    if ((res as { code?: string }).code === 'session_ended') {
      // 如果客户端已经换成新会话，就不能停在旧结果上，等这批结束后再试一次
      const current = (this.getContext() || ({} as RefillContext)).sessionId
      if (current && current !== requestSessionId) {
        this.recheckAfterFlight = true
      } else {
        this.sessionEnded = true
      }
      this.state = 'idle'
      return
    }
    this.fail(res as { code?: string; message?: string })
  }

  private fail(res: { code?: string; message?: string }): void {
    this.attempts += 1
    this.lastReason = { code: res.code || 'error', message: res.message || '' }
    const max = Math.max(1, this.config.maxAttempts)
    if (this.attempts >= max) {
      this.state = 'waiting_recovery'
      this.onStatus(
        `补歌已暂停：${labelFor(res.code)}${res.message ? '——' + res.message : ''}。点“下一首”或重新播放会再试一次。`,
        'bad',
      )
      this.onChange()
      return
    }
    const delay = Math.min(this.config.backoffBaseMs * 2 ** (this.attempts - 1), this.config.backoffMaxMs)
    this.nextRetryAt = this.now() + delay
    this.state = 'backoff'
    this.onStatus(
      `后台补歌失败（${labelFor(res.code)}），${Math.max(1, Math.round(delay / 1000))} 秒后重试（第 ${this.attempts}/${max} 次）。`,
      'warn',
    )
    this.scheduleTimer()
    this.onChange()
  }
}

/** 补歌批次里的曲目 → 节目条目（auto 标记），供 onBatch 适配使用。 */
export function pickToTrackItem(p: Record<string, unknown>, itemId: string): TrackItem {
  return {
    itemId,
    type: 'track',
    trackId: Number(p.id),
    name: String(p.name || ''),
    artists: String(p.artists || ''),
    album: String(p.album || ''),
    durationMs: Number(p.durationMs) || 0,
    auto: true,
    fromCodex: Boolean(p.fromCodex),
    addedAt: Date.now(),
  }
}
