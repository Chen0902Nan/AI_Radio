import path from 'node:path'
import type { NaturalPlaybackTrace } from './tool-types.d.ts'
import { isBatchTrackPlaying } from './playback-checks.mts'
import type { BrowserContext } from './orchestration-browser-adapter.mts'

export async function naturalContinuation(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'success' })
  // 用曲库中最短的一首做自然播完，控制验证时长
  const natural = tracks.slice().sort((a: { durationMs: number }, b: { durationMs: number }) => a.durationMs - b.durationMs)[0]
  await setSettings({ refillThreshold: '1', refillBatchSize: '3' })
  await setConfig({ threshold: 1, batchSize: 3 })
  await startPlaying([natural.id])
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 30000, label: '后台补充第一批' })
  const afterRefill = await state()
  check('网页：后台补歌只追加，不打断正在播放的歌', afterRefill.currentId === natural.id && afterRefill.paused === false && afterRefill.autoQueueIds.length > 0, {
    currentId: afterRefill.currentId,
    queueLength: afterRefill.queueLength,
    autoQueueIds: afterRefill.autoQueueIds,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-09-crossbatch-prep.png') })

  // 不拖进度：等这首自然播完触发真实的 ended，跨批边界由此产生
  let previousCross = afterRefill
  const playbackSamples = await waitFor(
    async () => {
      const s = await state()
      const playing = isBatchTrackPlaying(previousCross, s)
      const samples = playing ? [previousCross, s] : false
      previousCross = s
      return samples
    },
    { timeout: (natural.durationMs / 1000 + 90) * 1000, interval: 1000, label: '第一首自然播完并接入补歌批次' },
  )
  await recordNaturalContinuation(ctx, natural, playbackSamples)
  await page.screenshot({ path: path.join(OUT, 'shot-10-crossbatch-playing.png') })


}
export async function waitingRefill(ctx: BrowserContext) {
  const natural = ctx.tracks.slice().sort((a,b) => a.durationMs - b.durationMs)[0]
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4000 })
  await startPlaying([natural.id])
  await seekEnd() // 立刻把这首播完：此刻补歌还在路上
  await waitFor(async () => (await state()).awaitingRefill === true, { timeout: 15000, interval: 200, label: '进入等待补歌状态' })
  const waiting = await state()
  await waitFor(
    async () => {
      const s = await state()
      return s.autoQueueIds.includes(s.currentId) && !s.paused
    },
    { timeout: 20000, label: '批次到达后继续播放' },
  )
  const resumed = await state()
  check('网页：队列播完时进入等待，批次到达后自动继续（不停止播放）', waiting.awaitingRefill === true && resumed.autoQueueIds.includes(resumed.currentId) && resumed.paused === false && resumed.stopped === false, {
    waitingStatus: waiting.status,
    resumedId: resumed.currentId,
    fromBatch: resumed.autoQueueIds,
  })


}
export async function historyContinuation(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'success' })
  // 强制服务端返回第 1 首（此时它已是历史曲目）：验证不按整个历史队列去重
  await post('/api/_test/refill-forced-picks', { ids: [tracks[0].id], count: 1 })
  await setConfig({ threshold: 1, batchSize: 2 })
  await startPlaying([tracks[0].id, tracks[1].id, tracks[2].id])
  // 切到第 2 首：第 1 首成为历史，待播只剩 1 首，触发补歌；强制服务端返回那首已播过的歌
  await click('下一首')
  await waitFor(
    async () => {
      const s = await state()
      return s.currentId === tracks[1].id && !s.paused && s.queueLength === 4
    },
    { timeout: 30000, label: '已播曲目被重新补入队列' },
  )
  const historyBack = await state()
  check('网页：补歌返回已播过的歌曲时仍会追加（不按整个历史队列去重清零）', historyBack.queueLength === 4 && historyBack.autoQueueIds.includes(tracks[0].id) && historyBack.currentId === tracks[1].id, {
    queueLength: historyBack.queueLength,
    reAppended: historyBack.autoQueueIds,
    currentId: historyBack.currentId,
    prepStatus: historyBack.prepStatus,
  })
  // 把剩余待播播完，越过原队尾，继续播放重新补入的那首
  await seekEnd()
  await waitFor(async () => (await state()).currentId === tracks[2].id, { timeout: 20000, label: '切到第三首' })
  await seekEnd()
  await waitFor(
    async () => {
      const s = await state()
      return s.currentId === tracks[0].id && !s.paused
    },
    { timeout: 20000, label: '越过原队尾继续播放' },
  )
  const tail = await state()
  check('网页：完整队列播到底后继续播放（不因队列耗尽停止）', tail.currentId === tracks[0].id && tail.paused === false && tail.stopped === false, {
    currentId: tail.currentId,
    queueLength: tail.queueLength,
    status: tail.status,
  })
  await post('/api/_test/refill-forced-picks', { ids: [] })


}

async function recordNaturalContinuation(ctx: BrowserContext, natural: BrowserContext['tracks'][number], playbackSamples: Array<Awaited<ReturnType<BrowserContext['state']>>>) {
  const { page, report, check } = ctx
  const cross = playbackSamples[1]
  const trace = await page.evaluate(() => window.__naturalPlayback)
  const { end } = trace
  const { wallMs, naturalCompleted } = measureNaturalCompletion(trace, natural.id)
  report.evidence.naturalContinuation = {
    ...trace, wallMs, naturalCompleted,
    playbackSamples: playbackSamples.map((s) => ({
      currentId: s.currentId, loadedId: s.loadedId, audioSrc: s.audioSrc,
      currentTime: s.currentTime, paused: s.paused, ended: s.ended,
      readyState: s.readyState, resolving: s.resolving, status: s.status,
    })),
  }
  check('网页：第一首自然播完后自动接入后台补充的一批（没有因队列耗尽停止）', naturalCompleted && isBatchTrackPlaying(playbackSamples[0], playbackSamples[1]), {
    currentId: cross.currentId,
    naturalTrack: { id: natural.id, durationSec: +(natural.durationMs / 1000).toFixed(1) },
    ended: end, wallMs, seeks: trace.seeks.length,
    loadedId: cross.loadedId,
    progress: playbackSamples.map((s) => s.currentTime),
    fromBatch: cross.autoQueueIds,
    status: cross.status,
  })
}

function measureNaturalCompletion(trace: NaturalPlaybackTrace, trackId: number) {
  const { start, end } = trace
  if (!start || !end) return { wallMs: null, naturalCompleted: false }
  const wallMs = end.atMs - start.atMs
  const evidence = {
    sameTrack: start.id === trackId && end.id === trackId,
    completeMedia: start.currentTime < 1 && end.duration > 0 && Math.abs(end.currentTime - end.duration) < 0.5,
    normalRate: start.playbackRate === 1 && end.playbackRate === 1,
    uninterrupted: trace.seeks.length === 0 && trace.rateChanges.length === 0,
    elapsedPlayback: wallMs >= (end.duration - start.currentTime) * 1000 - 2000,
  }
  return { wallMs, naturalCompleted: Object.values(evidence).every(Boolean) }
}
