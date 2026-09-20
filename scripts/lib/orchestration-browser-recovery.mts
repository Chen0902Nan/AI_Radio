import path from 'node:path'
import type { NaturalPlaybackTrace } from './tool-types.d.ts'
import { isBatchTrackPlaying } from './playback-checks.mts'
import type { BrowserContext } from './orchestration-browser-adapter.mts'

export async function refreshSession(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'success' })
  await startPlaying([t1.id])
  const beforeReload = await state()
  const dbBefore = openDb()
  const playsBefore = dbBefore.prepare('SELECT COUNT(*) n FROM plays').get()!.n
  dbBefore.close()
  await loadPage()
  await waitFor(async () => (await state()).sessionId !== null, { timeout: 20000, label: '刷新后重连会话' })
  await sleep(1500)
  const afterReload = await state()
  const dbAfter = openDb()
  const playsAfter = dbAfter.prepare('SELECT COUNT(*) n FROM plays').get()!.n
  const openSessions = dbAfter.prepare('SELECT COUNT(*) n FROM sessions WHERE ended_at IS NULL').get()!.n
  dbAfter.close()
  check('网页：刷新只重连同一会话，不自动出声、不新建会话、不产生重复播放任务', afterReload.sessionId === beforeReload.sessionId && afterReload.paused === true && afterReload.audioSrc === '' && openSessions === 1 && playsAfter === playsBefore, {
    before: beforeReload.sessionId,
    after: afterReload.sessionId,
    paused: afterReload.paused,
    audioSrc: afterReload.audioSrc,
    openSessions,
    playsBefore,
    playsAfter,
  })


}
export async function quickSkip(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 3500 })
  await startPlaying([t1.id, t2.id, tracks[2].id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（切歌用例）' })
  // 先等第一首真正开始
  await click('下一首')
  await sleep(120)
  await click('下一首')
  await waitFor(async () => {
    const s = await state()
    return s.currentId === tracks[2].id && !s.paused
  }, { timeout: 30000, label: '快速切歌到最后选择' })
  await waitFor(async () => (await state()).refill.inFlight === false, { timeout: 20000, label: '补歌完成' })
  await sleep(800)
  const quick = await state()
  check('网页：补歌结果不会覆盖用户快速切歌的选择', quick.currentId === tracks[2].id && quick.paused === false, {
    currentId: quick.currentId,
    expected: tracks[2].id,
    paused: quick.paused,
  })


}
export async function degradedContinuation(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'quota' })
  await setSettings({ refillThreshold: '5', refillBatchSize: '3' })
  await setConfig({ threshold: 5, batchSize: 3 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 30000, label: '降级批次到达' })
  const degraded = await state()
  check('网页：Codex 失败时用曲库候选降级续播，界面说明清楚，播放不中断', degraded.queueLength > 1 && degraded.paused === false && /Codex 暂不可用|降级/.test(degraded.prepStatus) && degraded.autoQueueIds.length > 0, {
    queueLength: degraded.queueLength,
    prepStatus: degraded.prepStatus,
    paused: degraded.paused,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-12-degraded-continue.png') })
  // 降级补入的歌曲要真的能播，而不只是追加进队列
  await seekEnd()
  await waitFor(
    async () => {
      const s = await state()
      return s.autoQueueIds.includes(s.currentId) && !s.paused && s.currentTime > 0.5
    },
    { timeout: 20000, label: '播放降级补入的歌曲' },
  )
  const degradedPlay = await state()
  check('网页：降级补入的歌曲能真实播放', degradedPlay.autoQueueIds.includes(degradedPlay.currentId) && degradedPlay.paused === false, {
    currentId: degradedPlay.currentId,
    fromDegradedBatch: degradedPlay.autoQueueIds,
    currentTime: +degradedPlay.currentTime.toFixed(2),
  })


}
