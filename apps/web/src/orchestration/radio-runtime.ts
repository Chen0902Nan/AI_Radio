/**
 * 应用装配与全局状态（迁移自 public/app.js 的顶层编排）：
 *  - 单一 PlaybackController 实例（模块级单例 + React Context 提供，StrictMode 重复
 *    mount 不会重复创建——audio 生命周期独立于 React 渲染）。
 *  - 队列、会话、反馈等应用状态通过 useSyncExternalStore 订阅控制器与本地 store。
 *  - 组件只发命令，不直接操作 audio。
 */
import { PlaybackController } from '../playback/playback-controller'
import { api } from '../api/client'
import {
  makeTrackItem,
  type TrackItem,
  type SegueScript,
  type SessionInfo,
} from '@radio/contracts'

/* ---------- RefillController / SegueController（TS 迁移版，parity 20 项验证） ---------- */

import { RefillController } from './refill-controller'
import { createAppStore, type AppStore } from './app-store'
import { DjSettingsController } from './dj-settings'
import { VoicePreviewController } from './voice-preview'
import { DjJobWatcher, type WatchedJobResult } from './dj-job-watcher'
import { PlayRecords } from './play-records'
import { RadioEvents } from './radio-events'
import { SourceSelection } from './source-selection'
import type { PrepareRequestPayload } from './segue-controller'
import { SegueController } from './segue-controller'


/* ---------- 应用级状态（队列之外的轻量 store） ---------- */

/* ---------- Context ---------- */

export interface RadioContextValue {
  sources: SourceSelection
  selectManual: (tracks: TrackItem[], label: string) => void
  startListening: () => Promise<void>
  stopListening: () => Promise<void>
  connect: () => () => void
  settings: DjSettingsController
  preview: VoicePreviewController
  playback: PlaybackController
  refill: InstanceType<typeof RefillController>
  segue: InstanceType<typeof SegueController>
  store: ReturnType<typeof createAppStore>
}


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
  if (decision.type === 'continue-track') await continueTrack(playback, decision.targetItemId)
}

async function continueTrack(playback: PlaybackController, targetItemId?: string): Promise<void> {
    // 目标歌曲：优先按 targetItemId 找条目（串场结束后接它介绍的那首）
    const snap = playback.getSnapshot()
    let idx = -1
    if (targetItemId) {
      idx = playback.queue.findIndex((t) => t.itemId === targetItemId)
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

function createPlayback(): PlaybackController {
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
        playRecords.close('skipped')
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
        void playRecords.start(item, playInstanceId)
      },
      onTrackStarted: (item, next, playInstanceId) => {
        singleton?.preview.stop()
        stoppedIntent = false
        if (storeRef?.get().preparingStart) cancelInitialPreparation()
        playRecords.close('skipped')
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
        playRecords.close('ended')
        // 自然播完：唯一累计点 → 控制器决定播 DJ 还是继续歌曲
        const decision = segueRef?.onTrackEnded({ item, playInstanceId, natural: true, at: Date.now() })
        if (decision) void executeSegueDecision(decision)
      },
      onTrackFailed: (item, reason) => {
        playRecords.close('failed')
        storeRef?.set({ status: { text: reason, cls: 'warn' } })
        if (item) {
          failedIds.add(item.trackId)
          // 播放失败不累计串场计数；机会随下一次进入歌曲重建
          segueRef?.onTrackFailed({ item, at: Date.now() })
        }
      },
      onTrackSkipped: () => {
        playRecords.close('skipped')
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
        sessionRevision += 1
        singleton?.preview.stop()
        stoppedIntent = true
        cancelInitialPreparation()
        storeRef?.set({radioPrepared: false})
        playRecords.close('stopped')
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

return playback
}

function createRefill(playback: PlaybackController): RefillController {
  const refill = new RefillController({
    requestBatch: async ({ epoch, excludeIds, brief, sessionId }: { epoch: number; excludeIds: number[]; brief: string; sessionId: string | null }) => {
      const data = await api.refill({
        sessionId: sessionId || storeRef!.get().sessionId,
        epoch,
        excludeIds,
        count: refill.config.batchSize,
        brief,
      })
      return { ...data }
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
      if (added.length && picks[0]?.degraded) {
        storeRef!.set({ prepStatus: { text: `Codex 暂不可用，已用曲库候选降级续播 ${added.length} 首（不打断当前歌曲）。`, cls: 'prep warn' } })
      }
      return added
    },
})
return refill
}

function createSegue(): SegueController {
  const segue = new SegueController({
    requestPrepare: async (req: PrepareRequestPayload) => {
      // 提交准备并轮询到终态（旧 prepareSegueRequest 语义：任何失败都返回可处理结果）
      try {
        if (!req.sessionId) return { state: 'stale', reason: 'missing_session' }
        const res = await api.djPrepare({ ...req, sessionId: req.sessionId })
        if (!res.ok) {
          return { state: 'unavailable', code: res.code || 'error', message: res.message }
        }
        let cur: WatchedJobResult = res.job
        if (cur.state === 'unavailable' || cur.state === 'stale') {
          return { state: cur.state, segueId: cur.segueId, reason: cur.reason, code: cur.code, message: cur.message }
        }
        cur = await watchedJobs.wait(req, cur)
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
      watchedJobs.reconcile()
      if (!storeRef || !segueRef) return
      const snap = segueRef.snapshot()
      const ready = snap.ready as { script: SegueScript } | null
      const labels: Record<string, string> = { preparing: 'DJ 正在准备下一段串场…', ready: 'DJ 串场已就绪。', playing: 'DJ 正在播报。', stopped: 'DJ 已停止。', paused: 'DJ 已暂停。' }
      storeRef.set({ djScript: ready?.script ?? (snap.state === 'playing' ? storeRef.get().djScript : null), djStatus: { text: labels[String(snap.state)] || 'DJ 等待下一次串场机会。', cls: 'prep' } })
    },
})
return segue
}

export function getRadioInstance(): RadioContextValue {
  if (!singleton) {
    const playback = createPlayback()
    const refill = createRefill(playback)
    const segue = createSegue()
    const store = createAppStore()
    playbackRef = playback
    storeRef = store
    segueRef = segue
    playbackSingleton = playback
    const settings = new DjSettingsController({ read: api.settings, save: api.saveSetting, apply: config => segue.setConfig(config) })
    settings.subscribe(() => {
      const state = settings.getSnapshot()
      store.set({ settings: state.settings, djVoice: state.djVoice })
      refill.setConfig({
        threshold: state.settings.refillThreshold,
        batchSize: state.settings.refillBatchSize,
        backoffBaseMs: state.settings.refillBackoffBaseMs,
        backoffMaxMs: state.settings.refillBackoffMaxMs,
        maxAttempts: state.settings.refillMaxAttempts,
      })
    })
    const preview = new VoicePreviewController({
      request: api.djPreview,
      isListening: () => !!store.get().sessionId || store.get().preparingStart,
      play: url => playback.startPreview(url),
      cancel: () => playback.cancelPreview(),
      save: voice => settings.save('djVoiceReferenceId', voice),
    })
    const sources = new SourceSelection(playback, refill, store, epoch => {
      cancelInitialPreparation()
      segue.setEpoch(epoch)
    })
    singleton = { playback, refill, segue, store, settings, preview, sources, connect: radioEvents.connect, startListening, stopListening,
      selectManual: (tracks, label) => sources.selectManual(tracks, label),
    }
  }
  return singleton
}


let startSequence = 0
let sessionRevision = 0
let stoppedIntent = false
let stopRequest: Promise<unknown> | null = null
function cancelInitialPreparation(): void {
  startSequence += 1
  storeRef?.set({preparingStart: false})
}

function restoreSessionEpoch(highestEpoch: number): void {
  const { refill, segue } = getRadioInstance()
  if (refill.epoch <= highestEpoch) {
    refill.cancel('session_restored', { reset: true })
    refill.epoch = Math.max(refill.epoch, highestEpoch + 1)
  }
  segue.setEpoch(refill.epoch)
}

function listeningPreparation(state: AppStore): { fresh: boolean; status: AppStore['status'] } {
  const fresh = state.queueMode === 'radio' && !state.radioPrepared
  return { fresh, status: { text: fresh ? '正在准备混合首批歌曲…' : '正在开始收听…', cls: 'prep' } }
}

async function startListening(): Promise<void> {
  const {playback, store, preview} = getRadioInstance()
  preview.stop()
  if (store.get().preparingStart) { playback.pause(); return }
  stoppedIntent = false
  sessionRevision += 1
  const sequence = ++startSequence
  const { fresh, status } = listeningPreparation(store.get())
  store.set({ preparingStart: true, status })
  try {
    if (stopRequest) await stopRequest
    if (sequence !== startSequence) return
    const sessionId = await ensureListeningSession(sequence)
    if (!sessionId || sequence !== startSequence) return
    if (!fresh) { store.set({preparingStart: false}); await playback.resume(); return }
    await prepareFirstBatch(sequence, sessionId)
  } catch (err) {
    if (sequence === startSequence) store.set({preparingStart: false, status: {text: (err as Error).message, cls: 'bad'}})
  } finally {
    if (sequence === startSequence) store.set({preparingStart: false})
  }
}

async function ensureListeningSession(sequence: number): Promise<string | null> {
  const { store } = getRadioInstance()
  if (store.get().sessionId) return store.get().sessionId
  const result = await api.sessionStart()
  if (sequence !== startSequence) {
    if (stoppedIntent) await api.sessionStop().catch(() => {})
    return null
  }
  if (!result.ok) throw new Error(result.message || '无法开始收听')
  const session = result.session
  if (!session) throw new Error('无法开始收听')
  restoreSessionEpoch(session.highest_epoch)
  store.set({ sessionId: session.id })
  return session.id
}

async function prepareFirstBatch(sequence: number, sessionId: string): Promise<void> {
  const { playback, refill, store } = getRadioInstance()
  const epoch = refill.cancel('initial_batch', { reset: true })
  const result = await api.refill({ sessionId, epoch, excludeIds: [], count: refill.config.batchSize, brief: '按我的口味准备混合电台，适当探索不同语言或曲风' })
  if (sequence !== startSequence || epoch !== refill.epoch || sessionId !== store.get().sessionId) return
  if (!result.ok) throw new Error(result.message || '首批准备失败，请重试')
  if (!result.picks.length) throw new Error('没有完整可播歌曲，请稍后重试')
  playback.replaceQueue(result.picks.map(pick => makeTrackItem({ ...pick, auto: true })))
  store.set({ radioPrepared: true, preparingStart: false, sourceLabel: '混合电台 · 50% 探索', status: { text: result.message || '混合首批已准备好。', cls: result.degraded ? 'warn' : 'ok' } })
  await playback.play(0, { userGesture: true })
}

async function stopListening(): Promise<void> {
  const {playback, store, preview} = getRadioInstance()
  preview.stop()
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

const watchedJobs = new DjJobWatcher({
  current: req => storeRef!.get().sessionId === req.sessionId && singleton!.refill.epoch === req.epoch && segueRef!.snapshot().transitionId === req.transitionId,
  connected: () => storeRef!.get().eventsConnected,
  cancel: api.djCancel,
  read: api.djJob,
})

let snapshotRequest = 0

async function syncServerSnapshot(): Promise<void> {
  const request = ++snapshotRequest
  const revision = sessionRevision
  const sessionId = storeRef!.get().sessionId
  try {
    const [, feedback, session] = await Promise.all([singleton!.settings.refresh(), api.feedback(), api.session()])
    if (request !== snapshotRequest || revision !== sessionRevision || sessionId !== storeRef!.get().sessionId) return
    if (feedback.ok) {
      const active = feedback.active
      storeRef!.set({ feedback: Object.fromEntries(active.map((r) => [String(r.track_id), r.sentiment])), feedbackNames: Object.fromEntries(active.map(r => [String(r.track_id), r.track_name || '未命名歌曲'])) })
    }
    if (session.ok) synchronizeSession(sessionId, session.session)

  } catch (_) { /* 断线不结束收听；任务轮询负责有界降级。 */ }
}

function synchronizeSession(localId: string | null, session: SessionInfo | null): void {
  const { playback, store } = getRadioInstance()
  if (localId && session?.id !== localId) {
    playback.stop()
    store.set({ sessionId: null, adjustments: {}, status: { text: '收听会话已结束，请重新开播。', cls: 'warn' } })
    return
  }
  if (localId || !session || stoppedIntent || store.get().preparingStart) return
  restoreSessionEpoch(session.highest_epoch)
  const adjustments = Object.fromEntries(Object.entries(session.adjustments).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  store.set({ sessionId: session.id, adjustments })
}

const radioEvents = new RadioEvents({
  context: () => ({ sessionId: storeRef!.get().sessionId, epoch: singleton!.refill.epoch }),
  refreshSettings: () => { void singleton!.settings.refresh() },
  opened: () => {
    storeRef!.set({ eventsConnected: true })
    void syncServerSnapshot()
    watchedJobs.refresh()
  },
  disconnected: () => {
    storeRef!.set({ eventsConnected: false })
    watchedJobs.reconcile()
  },
  released: () => {
    snapshotRequest += 1
    singleton!.settings.invalidateReads()
    singleton!.preview.stop()
    storeRef!.set({ eventsConnected: false })
    watchedJobs.cancel()
  },
  notice: message => {
    if (message.type === 'config-changed') void syncServerSnapshot()
    if (message.type !== 'dj-status' || typeof message.segueId !== 'string') return
    const job = watchedJobs.get(message.segueId)
    if (!job) return
    if (job.req.sessionId !== message.sessionId || job.req.epoch !== message.epoch) return
    if (job.req.transitionId === message.transitionId) void job.refresh()
  },
})

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

const playRecords = new PlayRecords({
  sessionId: () => storeRef?.get().sessionId ?? null,
  onClosed: () => { storeRef?.set({ playId: null }) },
  onStarted: (playId, session) => {
    const sessionId = session.id
    if (storeRef!.get().sessionId !== sessionId) restoreSessionEpoch(session.highest_epoch ?? 0)
    storeRef!.set({ playId, sessionId })
    if (segueRef?.snapshot().sessionId !== sessionId || segueRef.snapshot().stopped) {
      segueRef?.startSession({ sessionId, epoch: Number(singleton?.refill.epoch) || 0 })
      const snap = playbackRef!.getSnapshot()
      segueRef?.onTrackStarted({ item: playbackRef!.itemAt(snap.index), next: playbackRef!.itemAt(snap.index + 1), playInstanceId: snap.mediaPlayInstance ?? undefined })
    }
    singleton?.refill.sessionReady()
  },
})
