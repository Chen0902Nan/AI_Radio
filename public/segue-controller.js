/**
 * 串场机会控制器（任务 04）：把「何时准备、何时可播、何时必须作废」收敛为一个
 * 无 DOM、无 audio 的纯逻辑模块，可被 Node 直接测试（模式同 public/orchestrator.js）。
 *
 * 职责（依据契约第 2 节与 Q2/Q7/Q8/Q9）：
 *  - 维护自然结束计数：只在当前歌曲播放实例的有效 ended 上累计一次；
 *    手动下一首、直接选曲、解析/播放失败、DJ 的 ended 均不累计。
 *  - 进入歌曲时，自然完成数达到 djIntervalTracks - 1 且已知紧邻下一首（且可播），
 *    就通过注入的 requestPrepare 提前为「本曲结束 → 下一首开始」的机会准备串场。
 *  - 自然结束时一次性决定：到期 + DJ 就绪 + 目标未变 → play-segue；否则关闭机会继续音乐。
 *  - 机会一旦关闭（结束决定、跳过、换目标、停止、epoch 变更），所有迟到结果
 *    失去排程资格——以 requestId + transitionId 双重核对，旧任务结束也清不掉新任务的在途标志。
 *  - DJ 首次实际出声（onSeguePlaying）才把计数清零一次；未出声失败/被取消不清零。
 *  - 服务失败进入 60 秒起倍增、15 分钟封顶的有界冷却；配置/认证错误在配置更新前不重复请求。
 *  - 暂停保留在途结果但不出声、不启动新准备；停止清空机会、计数与任务绑定。
 *
 * 它不操作补歌队列、不维护第二套音乐队列；只通过注入函数请求/取消准备，
 * 通过返回的决定对象让 06 执行播放动作。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.RadioSegueController = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  const { makeTransition, closeTransition, isTransitionOpen, validatePrepareRequest } =
    typeof require === 'function' && typeof module === 'object' && module.exports
      ? require('./program-contract')
      : typeof globalThis !== 'undefined'
        ? globalThis.RadioProgramContract
        : this.RadioProgramContract

  const DEFAULTS = {
    djEnabled: true,
    djIntervalTracks: 4,
    brief: '',
  }
  const INTERVAL_OPTIONS = [3, 4, 5]
  const COOLDOWN_BASE_MS = 60 * 1000
  const COOLDOWN_MAX_MS = 15 * 60 * 1000
  /** 配置/认证类失败：不进入时间冷却，而是阻塞到配置更新。 */
  const CONFIG_BLOCK_CODES = ['not_configured', 'auth', 'unknown_model', 'invalid_reference']

  class SegueController {
    constructor(opts = {}) {
      this.requestPrepare = opts.requestPrepare || (() => Promise.resolve({ state: 'unavailable', code: 'not_configured' }))
      this.cancelPrepare = opts.cancelPrepare || (() => {})
      this.onChange = opts.onChange || (() => {})
      this.now = opts.now || (() => Date.now())
      this.config = { ...DEFAULTS, ...(opts.config || {}) }

      this.sessionId = null
      this.epoch = 0
      this.stopped = true
      this.paused = false
      this.naturalCount = 0
      this.currentItem = null
      this.nextItem = null
      this.nextPlayable = undefined
      this.transition = null // 打开中的机会（contract.makeTransition 形状）
      this.pending = null // { requestId, transitionId, targetItemId, segueId?, state, ready? }
      this.requestSeq = 0
      this.currentPlayInstance = null
      this.lastCountedEndedInstance = null
      this.countResetForSegue = null
      this.consecutiveFailures = 0
      this.cooldownUntil = 0
      this.blockedReason = null
      this.lastReason = null
      this.stats = { prepares: 0, cancels: 0, plays: 0, lateDiscards: 0, failures: 0 }
    }

    /* ---------- 会话与配置 ---------- */

    /** 开播/重开：清空全部机会状态，从 0 计数。 */
    startSession({ sessionId, epoch = 0 }) {
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
    setEpoch(epoch) {
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
    setConfig(partial = {}) {
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
        // 未播成品作废；已出声的 DJ 由 06 继续播完，这里的计数不受影响
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
    onTrackStarted({ item, next, nextPlayable, playInstanceId, at } = {}) {
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
    onTrackFailed({ item, at } = {}) {
      if (item && this.currentItem && item.itemId !== this.currentItem.itemId) {
        return this._decide('none', 'stale_item', at)
      }
      this._closeGap('track_failed', { cancel: true })
      return this._decide('none', 'track_failed', at)
    }

    /** 队列改变：紧邻下一首被补歌/操作替换时，目标变更的机会随之重建。 */
    onQueueChanged({ next, nextPlayable, at } = {}) {
      if (this.stopped) return this._decide('none', 'stopped', at)
      const targetChanged = (next && this.nextItem && next.itemId !== this.nextItem.itemId) ||
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
    onSkipped({ at } = {}) {
      this._closeGap('skipped', { cancel: true })
      return this._decide('none', 'skipped', at)
    }

    /** 自然结束：唯一累计点；到期时一次性决定播 DJ 还是继续歌曲。 */
    onTrackEnded({ item, playInstanceId, natural, at } = {}) {
      if (this.stopped) return this._decide('none', 'stopped', at)
      if (natural !== true) return this._decide('none', 'not_natural', at)
      if (playInstanceId && this.currentPlayInstance && playInstanceId !== this.currentPlayInstance) {
        return this._decide('none', 'stale_instance', at)
      }
      if (playInstanceId && this.lastCountedEndedInstance === playInstanceId) {
        return this._decide('none', 'duplicate_ended', at)
      }
      if (item && this.currentItem && item.itemId !== this.currentItem.itemId) {
        return this._decide('none', 'stale_item', at)
      }
      this.lastCountedEndedInstance = playInstanceId || null
      this.naturalCount += 1

      const due = this.naturalCount >= this.config.djIntervalTracks
      const playable =
        this.config.djEnabled &&
        due &&
        !this.paused &&
        this.transition &&
        isTransitionOpen(this.transition) &&
        this.pending &&
        this.pending.state === 'ready' &&
        this.pending.transitionId === this.transition.transitionId &&
        this.nextItem &&
        this.pending.targetItemId === this.nextItem.itemId &&
        this.nextPlayable !== false
      if (playable) {
        this.pending.state = 'playing'
        this.stats.plays += 1
        const d = this._decide('play-segue', 'ready_and_due', at, {
          segue: {
            segueId: this.pending.segueId,
            transitionId: this.transition.transitionId,
            targetItemId: this.nextItem.itemId,
            targetTrackId: this.nextItem.trackId,
            script: this.pending.ready.script,
            audio: this.pending.ready.audio,
          },
        })
        return d
      }
      this._closeGap(due ? 'not_ready' : 'interval_not_due', { cancel: false })
      return this._decide('continue-track', due ? 'due_but_not_ready' : 'interval_not_due', at, {
        targetItemId: this.nextItem ? this.nextItem.itemId : undefined,
      })
    }

    /* ---------- DJ 生命周期 ---------- */

    /** DJ 首次实际出声：清零计数（每个 segueId 只清一次）。 */
    onSeguePlaying({ segueId, at } = {}) {
      if (this.pending && segueId && this.pending.segueId === segueId && this.countResetForSegue !== segueId) {
        this.naturalCount = 0
        this.countResetForSegue = segueId
      }
      return this._decide('none', 'segue_playing', at)
    }

    /** DJ 完整结束：进入目标歌曲。 */
    onSegueEnded({ segueId, at } = {}) {
      const targetItemId = this.pending && this.pending.segueId === segueId ? this.pending.targetItemId : this.nextItem && this.nextItem.itemId
      this._closeGap('segue_finished', { cancel: false })
      return this._decide('continue-track', 'segue_finished', at, { targetItemId })
    }

    /** DJ 被用户跳过：已出声则本轮已用（计数已清零），未出声则计数保持到期。 */
    onSegueSkipped({ segueId, at } = {}) {
      this._closeGap('segue_skipped', { cancel: false })
      return this._decide('none', 'segue_skipped', at)
    }

    /** DJ 失败：started=false 表示从未出声，计数保持到期（下一机会可再准备）。 */
    onSegueFailed({ segueId, started = false, at } = {}) {
      this._closeGap(started ? 'segue_failed_after_start' : 'segue_failed_before_start', { cancel: false })
      return this._decide('continue-track', 'segue_failed', at, {
        targetItemId: this.nextItem ? this.nextItem.itemId : undefined,
      })
    }

    /* ---------- 暂停 / 停止 ---------- */

    onPaused({ at } = {}) {
      this.paused = true
      return this._decide('none', 'paused', at)
    }

    onResumed({ at } = {}) {
      this.paused = false
      const prepared = this.maybePrepare()
      return this._decide(prepared ? 'prepare' : 'none', prepared ? 'preparing_next_gap' : 'resumed', at)
    }

    onStopped({ at } = {}) {
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
    maybePrepare() {
      if (this.stopped || this.paused || !this.config.djEnabled) return false
      if (this.blockedReason) return false
      if (this.now() < this.cooldownUntil) return false
      if (!this.transition || !isTransitionOpen(this.transition)) return false
      if (!this.nextItem || this.nextPlayable === false) return false
      if (this.pending) return false
      if (this.naturalCount < this.config.djIntervalTracks - 1) return false

      const req = {
        sessionId: this.sessionId,
        epoch: this.epoch,
        transitionId: this.transition.transitionId,
        fromItemId: this.transition.fromItemId,
        targetItemId: this.transition.targetItemId,
        targetTrackId: this.transition.targetTrackId,
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
      let p
      try {
        p = this.requestPrepare(req)
      } catch (err) {
        p = Promise.reject(err)
      }
      Promise.resolve(p)
        .then((res) => this._onPrepareResult(requestId, res || { state: 'unavailable', code: 'error' }))
        .catch((err) =>
          this._onPrepareResult(requestId, {
            state: 'unavailable',
            code: 'network',
            message: String((err && err.message) || err),
          }),
        )
        .finally(() => this.onChange())
      return true
    }

    /** 准备结果到达：只对「仍在途的同一请求 + 仍打开的同一机会」生效。 */
    _onPrepareResult(requestId, res) {
      if (!this.pending || this.pending.requestId !== requestId) {
        this.stats.lateDiscards += 1
        return { type: 'none', reason: 'late_result_discarded' }
      }
      const transitionAlive = this.transition && isTransitionOpen(this.transition) && this.transition.transitionId === this.pending.transitionId
      if (!transitionAlive) {
        this.pending = null
        this.stats.lateDiscards += 1
        return { type: 'none', reason: 'transition_closed' }
      }
      const state = res.state
      if (state === 'ready') {
        if (!res.segueId || !res.script || !res.audio) {
          this.pending = null
          return this._recordFailure({ code: 'invalid_output', message: 'ready 结果缺少成品字段' })
        }
        this.pending.state = 'ready'
        this.pending.segueId = res.segueId
        this.pending.ready = { script: res.script, audio: res.audio }
        this.consecutiveFailures = 0
        this.cooldownUntil = 0
        this.lastReason = null
        return { type: 'none', reason: 'ready' }
      }
      // unavailable / stale / preparing 异常返回
      this.pending = null
      if (state === 'stale') {
        this.lastReason = { code: 'stale', message: res.reason || '' }
        return { type: 'none', reason: 'stale' }
      }
      return this._recordFailure({ code: res.code || res.reason || 'error', message: res.message || '' })
    }

    _recordFailure({ code, message }) {
      this.stats.failures += 1
      this.lastReason = { code, message }
      if (CONFIG_BLOCK_CODES.includes(code)) {
        this.blockedReason = code
        return { type: 'none', reason: 'blocked_by_config' }
      }
      this.consecutiveFailures += 1
      const delay = Math.min(COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1), COOLDOWN_MAX_MS)
      this.cooldownUntil = this.now() + delay
      return { type: 'none', reason: 'cooldown', cooldownMs: delay }
    }

    /* ---------- 内部 ---------- */

    _openTransitionIfNeeded() {
      if (!this.currentItem || !this.nextItem) return
      if (this.transition && isTransitionOpen(this.transition) && this.transition.targetItemId === this.nextItem.itemId) return
      this.transition = makeTransition({
        sessionId: this.sessionId,
        epoch: this.epoch,
        fromItemId: this.currentItem.itemId,
        targetItemId: this.nextItem.itemId,
        targetTrackId: this.nextItem.trackId,
      })
    }

    /** 关闭当前机会。cancel=true 时尽力取消在途任务；就绪未播的成品一并作废。 */
    _closeGap(reason, { cancel = false } = {}) {
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

    _decide(type, reason, at, extra = {}) {
      const decision = { type, reason, at: Number(at) || this.now(), ...extra }
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

  return { SegueController, DEFAULTS, INTERVAL_OPTIONS, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS }
})
