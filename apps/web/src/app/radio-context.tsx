/**
 * 应用装配与全局状态（迁移自 public/app.js 的顶层编排）：
 *  - 单一 PlaybackController 实例（模块级单例 + React Context 提供，StrictMode 重复
 *    mount 不会重复创建——audio 生命周期独立于 React 渲染）。
 *  - 队列、会话、反馈等应用状态通过 useSyncExternalStore 订阅控制器与本地 store。
 *  - 组件只发命令，不直接操作 audio。
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { PlaybackController, type PlaybackSnapshot } from '../playback/playback-controller'
import { api, type LibraryTrack } from '../api/client'
import {
  makeTrackItem,
  type TrackItem,
  type SegueScript,
} from '@radio/contracts'

/* ---------- RefillController / SegueController（TS 迁移版，parity 20 项验证） ---------- */

import { RefillController } from '../orchestration/refill-controller'
import type { PrepareRequestPayload } from '../orchestration/segue-controller'
import { SegueController } from '../orchestration/segue-controller'

const SEGUE_POLL_MS = 2000
const SEGUE_POLL_DEADLINE_MS = 170000 // 略大于服务端 150s 总截止

/* ---------- 应用级状态（队列之外的轻量 store） ---------- */

export interface AppStore {
  preparingStart: boolean
  queueMode: 'radio' | 'manual'
  radioPrepared: boolean
  status: { text: string; cls: string }
  prepStatus: { text: string; cls: string }
  djStatus: { text: string; cls: string }
  sessionId: string | null
  adjustments: Record<string, string>
  playId: number | null
  feedback: Record<string, 'like' | 'dislike'>
  feedbackNames: Record<string, string>
  codexPicks: Array<{ id: number; name: string; reason: string }>
  sourceLabel: string
  awaitingRefill: boolean
  eventsConnected: boolean
  settings: Record<string, string>
  djScript: SegueScript | null
  djVoice: { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null } | null
}

const initialStore: AppStore = {
  preparingStart: false,
  queueMode: 'radio',
  radioPrepared: false,
  status: { text: '先登录并读取资料，然后点击开播。', cls: '' },
  prepStatus: { text: '后台补歌：待播不足时会自动准备下一批，不打断当前歌曲。', cls: 'prep' },
  djStatus: { text: '', cls: 'prep' },
  sessionId: null,
  adjustments: {},
  playId: null,
  feedback: {},
  feedbackNames: {},
  codexPicks: [],
  sourceLabel: '红心歌曲',
  awaitingRefill: false,
  eventsConnected: false,
  settings: {},
  djScript: null,
  djVoice: null,
}

function createAppStore() {
  let state: AppStore = initialStore
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch: Partial<AppStore>) {
      state = { ...state, ...patch }
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

/* ---------- Context ---------- */

interface RadioContextValue {
  selectManual: (tracks: TrackItem[], label: string) => void
  startListening: () => Promise<void>
  stopListening: () => Promise<void>
  connect: () => () => void
  playback: PlaybackController
  refill: InstanceType<typeof RefillController>
  segue: InstanceType<typeof SegueController>
  store: ReturnType<typeof createAppStore>
}

const RadioContext = createContext<RadioContextValue | null>(null)

/** 模块级单例：StrictMode 双重 mount 复用同一实例，不重复绑定媒体事件。 */
let singleton: RadioContextValue | null = null
let segueRef: InstanceType<typeof SegueController> | null = null
let playbackSingleton: PlaybackController | null = null

/**
 * 执行串场控制器的决定：
 *  - play-segue：DJ 就绪且到期 → 播出成品（同一音频出口），随后 onSeguePlaying/Ended 由媒体事件驱动
 *  - continue-track：进入目标歌曲（默认 index+1）
 *  - prepare/none：无播放动作
 */
async function executeSegueDecision(decision: { type: string; segue?: { segueId: string; audio: { url: string; durationMs: number }; script: { targetName?: string; targetArtists?: string } }; targetItemId?: string }): Promise<void> {
  const playback = playbackSingleton
  if (!playback) return
  if (decision.type === 'play-segue' && decision.segue) {
    await playback.playSegue(decision.segue)
    return
  }
  if (decision.type === 'continue-track') {
    // 目标歌曲：优先按 targetItemId 找条目（串场结束后接它介绍的那首）
    const snap = playback.getSnapshot()
    let idx = -1
    if (decision.targetItemId) {
      idx = playback.queue.findIndex((t) => t.itemId === decision.targetItemId)
    }
    if (idx < 0) idx = snap.index + 1
    if (idx < 0 || idx >= playback.queue.length) idx = snap.index + 1
    if (idx >= 0 && idx < playback.queue.length && playback.getSnapshot().userWantsPlayback) {
      await playback.play(idx)
    } else if (idx >= playback.queue.length && playback.getSnapshot().userWantsPlayback) {
      storeRef?.set({ awaitingRefill: true, status: { text: '正在等待下一批歌曲…', cls: 'prep' } })
      singleton?.refill.markAwaiting()
      singleton?.refill.check()
    }
  }
}

export function getRadioInstance(): RadioContextValue {
  if (!singleton) {
    // 复用 index.html 里的 <audio>（保持 DOM 存在，媒体状态可从页面观察）；不存在时退回内存 Audio
    const domAudio = typeof document !== 'undefined' ? (document.getElementById('audio') as HTMLAudioElement | null) : null
    const playback = new PlaybackController({
      audio: domAudio ?? undefined,
      events: {
        onUpcomingReplaced: () => {
          cancelInitialPreparation()
          const epoch = singleton?.refill.cancel('new_plan', { reset: true })
          segueRef?.setEpoch(epoch ?? 0)
          const snap = playback.getSnapshot()
          segueRef?.onTrackStarted({ item: playback.itemAt(snap.index), next: playback.itemAt(snap.index + 1), playInstanceId: snap.mediaPlayInstance ?? undefined })
          if (storeRef?.get().awaitingRefill && snap.userWantsPlayback && playback.itemAt(snap.index + 1)) {
            storeRef.set({ awaitingRefill: false })
            void playback.play(snap.index + 1)
          }
        },
        onQueueReplaced: () => {
          cancelInitialPreparation()
          closePlay('skipped')
          const epoch = singleton?.refill.cancel('source_changed', { reset: true })
          segueRef?.setEpoch(epoch ?? 0)
          failedIds.clear()
          storeRef?.set({ awaitingRefill: false })
        },
        onQueueExhausted: () => {
          storeRef?.set({ awaitingRefill: true, status: { text: '正在等待下一批歌曲…', cls: 'prep' } })
          singleton?.refill.markAwaiting()
          singleton?.refill.check()
        },
        onFirstPlaying: (item, playInstanceId) => {
          void notePlayStart(item, playInstanceId)
        },
        onTrackStarted: (item, next, playInstanceId) => {
          stoppedIntent = false
          if (storeRef?.get().preparingStart) cancelInitialPreparation()
          closePlay('skipped')
          if (item.auto) storeRef?.set({queueMode: 'radio', radioPrepared: true, sourceLabel: '混合电台 · 50% 探索'})
          const sessionId = storeRef?.get().sessionId
          if (sessionId && (segueRef?.snapshot().sessionId !== sessionId || segueRef.snapshot().stopped)) {
            segueRef?.startSession({ sessionId, epoch: Number(singleton?.refill.epoch) || 0 })
          }
          // 进入歌曲：通知串场控制器（达到间隔时触发提前准备），并恢复收听态
          segueRef?.onTrackStarted({ item, next, playInstanceId, at: Date.now() })
          segueRef?.onResumed({ at: Date.now() })
          singleton?.refill.check()
        },
        onNaturalEnded: (item, playInstanceId) => {
          closePlay('ended')
          // 自然播完：唯一累计点 → 控制器决定播 DJ 还是继续歌曲
          const decision = segueRef?.onTrackEnded({ item, playInstanceId, natural: true, at: Date.now() })
          if (decision) void executeSegueDecision(decision)
        },
        onTrackFailed: (item, reason) => {
          closePlay('failed')
          storeRef?.set({ status: { text: reason, cls: 'warn' } })
          if (item) {
            failedIds.add(item.trackId)
            // 播放失败不累计串场计数；机会随下一次进入歌曲重建
            segueRef?.onTrackFailed({ item, at: Date.now() })
          }
        },
        onTrackSkipped: () => {
          closePlay('skipped')
          // 手动下一首不累计；旧机会关闭、在途准备取消
          segueRef?.onSkipped({ at: Date.now() })
        },
        onPaused: () => {
          cancelInitialPreparation()
          // 暂停可保留在途串场结果，但不启动新准备、不让结果出声
          segueRef?.onPaused({ at: Date.now() })
        },
        onResumed: (userGesture) => {
          if (userGesture) singleton?.refill.resume()
          singleton?.refill.check()
          // 只解除暂停态；其返回的 prepare 决定不在此执行（由自然结束决定一次执行，避免循环）
          segueRef?.onResumed({ at: Date.now() })
        },
        onStopped: () => {
          stoppedIntent = true
          cancelInitialPreparation()
          storeRef?.set({radioPrepared: false})
          closePlay('stopped')
          segueRef?.onStopped({ at: Date.now() })
          singleton?.refill.cancel('stopped', { reset: true })
          storeRef?.set({ awaitingRefill: false })
        },
        onSeguePlaying: (sg) => {
          const d = segueRef?.onSeguePlaying({ segueId: sg.segueId, at: Date.now() })
          if (d) void executeSegueDecision(d)
        },
        onSegueEnded: (segueId) => {
          const d = segueRef?.onSegueEnded({ segueId, at: Date.now() })
          if (d) void executeSegueDecision(d)
        },
        onSegueFailed: (segueId, started) => {
          const d = segueRef?.onSegueFailed({ segueId, started, at: Date.now() })
          if (d) void executeSegueDecision(d)
        },
      },
    })
    playback.resolveTrack = (id, force) => api.resolve(id, force)
    playback.onConsecutiveFailuresExceeded = () => storeRef?.set({ status: { text: '连续三首歌曲不可播放，已暂停。请稍后重试。', cls: 'bad' } })

    const refill = new RefillController({
      requestBatch: async ({ epoch, excludeIds, brief, sessionId }: { epoch: number; excludeIds: number[]; brief: string; sessionId: string | null }) => {
        const data = await api.refill({
          sessionId: sessionId || storeRef!.get().sessionId,
          epoch,
          excludeIds,
          count: refill.config.batchSize,
          brief,
        })
        return data as { ok: boolean; [k: string]: unknown }
      },
      getContext: () => ({
        sessionId: storeRef!.get().sessionId,
        playing: playback.getSnapshot().userWantsPlayback && !storeRef!.get().preparingStart,
        stopped: false,
        pending: pendingCount(),
        brief: '继续按我的口味接着放',
      }),
      getExclusion: () => refillExclusion(),
      onStatus: (text: string, cls: string) => storeRef!.set({ prepStatus: { text, cls: 'prep' + (cls ? ' ' + cls : '') } }),
      onBatch: (picks: Array<Record<string, unknown>>) => {
        const added = appendPicks(picks)
        if (added.length && storeRef!.get().awaitingRefill && playback.getSnapshot().userWantsPlayback) {
          storeRef!.set({ awaitingRefill: false })
          refill.clearAwaiting()
          void playback.play(playback.getSnapshot().index + 1)
        }
        if (added.length && (picks[0] as { degraded?: boolean })?.degraded) {
          storeRef!.set({ prepStatus: { text: `Codex 暂不可用，已用曲库候选降级续播 ${added.length} 首（不打断当前歌曲）。`, cls: 'prep warn' } })
        }
        return added
      },
    })
    const segue = new SegueController({
      requestPrepare: async (req: PrepareRequestPayload) => {
        // 提交准备并轮询到终态（旧 prepareSegueRequest 语义：任何失败都返回可处理结果）
        try {
          const res = await api.djPrepare(req as unknown as Record<string, unknown>)
          if (!res.ok) {
            return { state: 'unavailable', code: (res.code as string) || 'error', message: res.message as string }
          }
          let cur = res.job as {
            state: string; segueId: string; reason?: string; code?: string; message?: string
            script?: unknown; audio?: unknown
          }
          if (cur.state === 'unavailable' || cur.state === 'stale') {
            return { state: cur.state, segueId: cur.segueId, reason: cur.reason, code: cur.code, message: cur.message }
          }
          cur = await waitForSegue(req, cur)
          if (cur.state === 'ready') {
            return { state: 'ready', segueId: cur.segueId, script: cur.script, audio: cur.audio }
          }
          return {
            state: cur.state === 'stale' ? 'stale' : 'unavailable',
            segueId: cur.segueId,
            reason: cur.reason,
            code: cur.code,
            message: cur.message,
          }
        } catch (err) {
          return { state: 'unavailable', code: 'network', message: String((err as Error).message) }
        }
      },
      cancelPrepare: (segueId: string, reason: string) => {
        api.djCancel(segueId, reason).catch(() => {})
      },
      onChange: () => {
        for (const job of watchedJobs.values()) job.reconcile()
        if (!storeRef || !segueRef) return
        const snap = segueRef.snapshot()
        const ready = snap.ready as { script: SegueScript } | null
        const labels: Record<string, string> = { preparing: 'DJ 正在准备下一段串场…', ready: 'DJ 串场已就绪。', playing: 'DJ 正在播报。', stopped: 'DJ 已停止。', paused: 'DJ 已暂停。' }
        storeRef.set({ djScript: ready?.script ?? (snap.state === 'playing' ? storeRef.get().djScript : null), djStatus: { text: labels[String(snap.state)] || 'DJ 等待下一次串场机会。', cls: 'prep' } })
      },
    })
    const store = createAppStore()
    playbackRef = playback
    storeRef = store
    segueRef = segue
    playbackSingleton = playback
    singleton = { playback, refill, segue, store, connect: connectRadioEvents, startListening, stopListening,
      selectManual: (tracks, label) => {
        playback.replaceQueue(tracks.map(t => ({...t, auto: false, selectionId: undefined})))
        store.set({queueMode: 'manual', radioPrepared: false, sourceLabel: label})
      },
    }
  }
  return singleton
}


let startSequence = 0
let stoppedIntent = false
let stopRequest: Promise<unknown> | null = null
function cancelInitialPreparation(): void {
  startSequence += 1
  storeRef?.set({preparingStart: false})
}

async function startListening(): Promise<void> {
  const {playback, refill, store} = getRadioInstance()
  if (store.get().preparingStart) { playback.pause(); return }
  stoppedIntent = false
  const sequence = ++startSequence
  const fresh = store.get().queueMode === 'radio' && !store.get().radioPrepared
  store.set({preparingStart: true, status: {text: fresh ? '正在准备混合首批歌曲…' : '正在开始收听…', cls: 'prep'}})
  try {
    if (stopRequest) await stopRequest
    if (sequence !== startSequence) return
    let sessionId = store.get().sessionId
    if (!sessionId) {
      const session = await api.sessionStart()
      if (sequence !== startSequence) {
        if (stoppedIntent) await api.sessionStop().catch(() => {})
        return
      }
      if (!session.ok) throw new Error(String(session.message || '无法开始收听'))
      sessionId = (session.session as {id: string}).id
      store.set({sessionId})
    }
    if (!fresh) { store.set({preparingStart: false}); await playback.resume(); return }
    const epoch = refill.cancel('initial_batch', {reset: true})
    const data = await api.refill({sessionId, epoch, excludeIds: [], count: refill.config.batchSize, brief: '按我的口味准备混合电台，适当探索不同语言或曲风'})
    if (sequence !== startSequence || epoch !== refill.epoch || sessionId !== store.get().sessionId) return
    if (!data.ok) throw new Error(String(data.message || '首批准备失败，请重试'))
    const picks = data.picks as Array<Record<string, unknown>>
    if (!picks?.length) throw new Error('没有完整可播歌曲，请稍后重试')
    playback.replaceQueue(picks.map(p => makeTrackItem({...p, auto: true})))
    store.set({radioPrepared: true, preparingStart: false, sourceLabel: '混合电台 · 50% 探索', status: {text: String(data.message || '混合首批已准备好。'), cls: data.degraded ? 'warn' : 'ok'}})
    await playback.play(0, {userGesture: true})
  } catch (err) {
    if (sequence === startSequence) store.set({preparingStart: false, status: {text: (err as Error).message, cls: 'bad'}})
  } finally {
    if (sequence === startSequence) store.set({preparingStart: false})
  }
}

async function stopListening(): Promise<void> {
  const {playback, store} = getRadioInstance()
  playback.cancelPreview()
  playback.stop()
  store.set({sessionId: null, adjustments: {}, playId: null, status: {text: '已停止收听。', cls: ''}})
  const request = api.sessionStop().catch(() => {})
  stopRequest = request
  await request
  if (stopRequest === request) stopRequest = null
}

// 内部引用（模块装配顺序需要）
let storeRef: ReturnType<typeof createAppStore> | null = null
let playbackRef: PlaybackController | null = null
const failedIds = new Set<number>()

interface WatchedJobResult {
  state: string; segueId: string; reason?: string; code?: string; message?: string; script?: unknown; audio?: unknown
}
const watchedJobs = new Map<string, { req: PrepareRequestPayload; refresh: () => Promise<void>; reconcile: () => void; cancel: () => void }>()

function waitForSegue(req: PrepareRequestPayload, initial: WatchedJobResult): Promise<WatchedJobResult> {
  if (initial.state !== 'preparing') return Promise.resolve(initial)
  return new Promise((resolve) => {
    let done = false, querying = false, refreshAgain = false
    let poll: ReturnType<typeof setTimeout> | null = null
    const finish = (result: WatchedJobResult) => {
      if (done) return
      done = true
      if (poll) clearTimeout(poll)
      clearTimeout(deadline)
      watchedJobs.delete(initial.segueId)
      resolve(result)
    }
    const deadline = setTimeout(() => finish({ ...initial, state: 'unavailable', code: 'timeout', message: '串场准备超时，继续音乐。' }), SEGUE_POLL_DEADLINE_MS)
    const current = () => storeRef!.get().sessionId === req.sessionId && singleton!.refill.epoch === req.epoch && segueRef!.snapshot().transitionId === req.transitionId
    const reconcile = () => {
      if (done) return
      if (!current()) {
        void api.djCancel(initial.segueId, 'superseded').catch(() => {})
        finish({ ...initial, state: 'stale', reason: 'superseded' })
        return
      }
      if (storeRef!.get().eventsConnected) {
        if (poll) clearTimeout(poll)
        poll = null
      } else if (!poll && !querying) {
        poll = setTimeout(() => { poll = null; void refresh() }, SEGUE_POLL_MS)
      }
    }
    const refresh = async () => {
      if (done) return
      if (querying) { refreshAgain = true; return }
      reconcile()
      if (done) return
      querying = true
      try {
        const result = await api.djJob(initial.segueId)
        if (done || !current()) return
        if (result.ok) {
          const job = result.job as WatchedJobResult
          if (job.segueId === initial.segueId && job.state !== 'preparing') finish(job)
        } else if (result.status === 404) finish({ ...initial, state: 'stale', reason: 'expired' })
      } catch (_) { /* 断线暂时不可查，保留任务至总截止。 */ }
      finally {
        querying = false
        reconcile()
        if (refreshAgain && !done) { refreshAgain = false; void refresh() }
      }
    }
    watchedJobs.set(initial.segueId, { req, refresh, reconcile, cancel: () => {
      void api.djCancel(initial.segueId, 'unmounted').catch(() => {})
      finish({ ...initial, state: 'stale', reason: 'unmounted' })
    } })
    reconcile()
    // 关闭 prepare 响应与注册订阅之间的就绪通知丢失窗口。
    if (!done) void refresh()
  })
}

let eventSource: EventSource | null = null
let connections = 0
let snapshotRequest = 0

async function syncServerSnapshot(): Promise<void> {
  const request = ++snapshotRequest
  const sessionId = storeRef!.get().sessionId
  const epoch = singleton!.refill.epoch
  try {
    const [settings, feedback, session] = await Promise.all([api.settings(), api.feedback(), api.session()])
    if (request !== snapshotRequest || epoch !== singleton!.refill.epoch || sessionId !== storeRef!.get().sessionId) return
    if (settings.ok) {
      const values = (settings.settings ?? {}) as Record<string, string>
      const oldVoice = storeRef!.get().djVoice
      const newVoice = (settings.djVoice as AppStore['djVoice']) ?? null
      const voiceConfigUpdated = oldVoice?.voiceReferenceId !== newVoice?.voiceReferenceId || oldVoice?.ready !== newVoice?.ready
      storeRef!.set({ settings: values, djVoice: newVoice })
      segueRef!.setConfig({ djEnabled: values.djEnabled !== 'false', djIntervalTracks: Number(values.djIntervalTracks) || 4, voiceConfigUpdated })
    }
    if (feedback.ok) {
      const active = (feedback.active ?? []) as Array<{ track_id: number; track_name?: string; sentiment: 'like' | 'dislike' }>
      storeRef!.set({ feedback: Object.fromEntries(active.map((r) => [String(r.track_id), r.sentiment])), feedbackNames: Object.fromEntries(active.map(r => [String(r.track_id), r.track_name || '未命名歌曲'])) })
    }
    if (session.ok && sessionId && (session.session as { id?: string } | null)?.id !== sessionId) {
      playbackRef!.stop()
      storeRef!.set({ sessionId: null, adjustments: {}, status: { text: '收听会话已结束，请重新开播。', cls: 'warn' } })
    }
  } catch (_) { /* 断线不结束收听；任务轮询负责有界降级。 */ }
}

function connectRadioEvents(): () => void {
  connections += 1
  if (!eventSource && typeof EventSource !== 'undefined') {
    const source = new EventSource('/api/events')
    let lastSeq = 0
    eventSource = source
    source.addEventListener('open', () => {
      if (eventSource !== source) return
      lastSeq = 0 // 服务重启后的新连接允许从新的序号开始；任务身份仍需核对。
      storeRef!.set({ eventsConnected: true })
      void syncServerSnapshot()
      for (const job of watchedJobs.values()) { job.reconcile(); void job.refresh() }
    })
    source.addEventListener('error', () => {
      if (eventSource === source) {
        storeRef!.set({ eventsConnected: false })
        for (const job of watchedJobs.values()) job.reconcile()
      }
    })
    source.addEventListener('event', (event: MessageEvent<string>) => {
      if (eventSource !== source) return
      try {
        const msg = JSON.parse(event.data)
        if (msg.v !== 1 || !Number.isSafeInteger(msg.seq) || msg.seq <= lastSeq) return
        if (msg.sessionId && msg.sessionId !== storeRef!.get().sessionId) return
        if (msg.epoch !== undefined && msg.epoch !== singleton!.refill.epoch) return
        lastSeq = msg.seq
        if (msg.type === 'config-changed') void syncServerSnapshot()
        if (msg.type === 'dj-status') {
          const job = watchedJobs.get(msg.segueId)
          if (job && job.req.sessionId === msg.sessionId && job.req.epoch === msg.epoch && job.req.transitionId === msg.transitionId) void job.refresh()
        }
      } catch (_) { /* 无效事件不是播放指令。 */ }
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    connections -= 1
    if (connections === 0) {
      eventSource?.close()
      eventSource = null
      snapshotRequest += 1
      storeRef!.set({ eventsConnected: false })
      for (const job of watchedJobs.values()) job.cancel()
    }
  }
}

/** 待播数量：只数歌曲条目（串场不进队列）。 */
function pendingCount(): number {
  if (!playbackRef) return 0
  const snap = playbackRef.getSnapshot()
  return Math.max(0, playbackRef.queue.length - (snap.index + 1))
}

/** 补歌排除范围：当前曲 + 待播 + 已失败（按平台歌曲 id）；已播历史可重新入队。 */
function refillExclusion(): number[] {
  if (!playbackRef) return []
  const ids = new Set<number>()
  const snap = playbackRef.getSnapshot()
  const queue = playbackRef.queue
  if (snap.currentTrackId && snap.currentKind === 'track') ids.add(Number(snap.currentTrackId))
  for (let i = snap.index + 1; i < queue.length; i += 1) ids.add(Number(queue[i].trackId))
  for (const id of failedIds) ids.add(id)
  return [...ids].filter((n) => Number.isFinite(n))
}

/** 补歌结果只追加、不替换；去重范围与发送的排除范围完全一致。 */
function appendPicks(picks: Array<Record<string, unknown>>): TrackItem[] {
  if (!playbackRef) return []
  const known = new Set(refillExclusion())
  const added: TrackItem[] = []
  for (const p of picks) {
    const id = Number(p.id)
    if (!Number.isFinite(id) || known.has(id)) continue
    known.add(id)
    added.push(makeTrackItem({ ...(p as object), auto: true }) as TrackItem)
  }
  playbackRef.appendQueue(added)
  segueRef?.onQueueChanged({ next: playbackRef.itemAt(playbackRef.getSnapshot().index + 1) })
  return added
}

interface PlayingRecord { id: number | null; outcome: string | null }
let activeRecord: PlayingRecord | null = null

function closePlay(outcome: string): void {
  const record = activeRecord
  if (!record) return
  activeRecord = null
  record.outcome = outcome
  storeRef?.set({ playId: null })
  if (record.id !== null) void api.playEnd(record.id, outcome).catch(() => {})
}

async function notePlayStart(item: TrackItem | null, playInstanceId: string): Promise<void> {
  if (!item || !storeRef) return
  const record: PlayingRecord = { id: null, outcome: null }
  activeRecord = record
  try {
    const data = await api.playStart({ trackId: item.trackId, trackName: item.name, artists: item.artists, sessionId: storeRef.get().sessionId, playInstanceId, selectionId: item.auto ? item.selectionId : undefined })
    if (!data.ok) return
    record.id = data.playId as number
    if (record.outcome) {
      await api.playEnd(record.id, record.outcome)
      return // 迟到的响应只收尾自己的记录，不能恢复已停止的会话
    }
    if (activeRecord !== record) return
    const sessionId = (data.session as { id: string }).id
    storeRef.set({ playId: record.id, sessionId })
    if (segueRef?.snapshot().sessionId !== sessionId || segueRef.snapshot().stopped) {
      segueRef?.startSession({ sessionId, epoch: Number(singleton?.refill.epoch) || 0 })
      const snap = playbackRef!.getSnapshot()
      segueRef?.onTrackStarted({ item: playbackRef!.itemAt(snap.index), next: playbackRef!.itemAt(snap.index + 1), playInstanceId: snap.mediaPlayInstance ?? undefined })
    }
    singleton?.refill.sessionReady()
  } catch (_) {}
}

export function RadioProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => {
    const inst = getRadioInstance()
    storeRef = inst.store
    return inst
  }, [])
  useEffect(() => value.connect(), [value])
  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>
}

export function useRadio(): RadioContextValue {
  const ctx = useContext(RadioContext)
  if (!ctx) throw new Error('useRadio 必须在 RadioProvider 内使用')
  return ctx
}

export function usePlaybackSnapshot(): PlaybackSnapshot {
  return useSyncExternalStore(useRadio().playback.subscribe, useRadio().playback.getSnapshot, useRadio().playback.getSnapshot)
}

export function useAppStore(): AppStore {
  const store = useRadio().store
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** 读取资料并适配为节目条目（旧 loadLibrary/selectSource 语义）。 */
export async function loadLibraryInto(playback: PlaybackController, store: ReturnType<typeof createAppStore>): Promise<void> {
  store.set({ status: { text: '正在读取账号音乐资料…', cls: '' } })
  try {
    const data = await api.library()
    if (!data.ok) throw new Error(String(data.message || `HTTP ${data.status}`))
    const tracks = (data.liked as { tracks: LibraryTrack[] }).tracks
    playback.replaceQueue(tracks.map((t) => makeTrackItem(t)))
    store.set({
      sourceLabel: '红心歌曲',
      status: { text: `已读取红心歌曲 ${tracks.length} 首，收藏/自建歌单 ${(data.playlists as { total: number }).total} 个。`, cls: 'ok' },
    })
  } catch (err) {
    store.set({ status: { text: '读取音乐资料失败：' + (err as Error).message + '（请先到 /login 扫码）', cls: 'bad' } })
  }
}
