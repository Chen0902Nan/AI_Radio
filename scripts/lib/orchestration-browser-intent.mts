import path from 'node:path'
import type { NaturalPlaybackTrace } from './tool-types.d.ts'
import { isBatchTrackPlaying } from './playback-checks.mts'
import type { BrowserContext } from './orchestration-browser-adapter.mts'

export async function slowPreparation(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4500 })
  await setSettings({ refillThreshold: '5', refillBatchSize: '3' })
  await setConfig({ threshold: 5, batchSize: 3 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途' })
  const slowA = await state()
  await sleep(2500)
  const slowB = await state()
  check('网页：Codex 生成较慢时，已有歌曲继续播放、没有被阻塞', slowA.currentId === slowB.currentId && slowB.paused === false && slowB.currentTime > slowA.currentTime, {
    currentId: slowB.currentId,
    advancedBy: +(slowB.currentTime - slowA.currentTime).toFixed(2),
    inFlightDuring: slowB.refill.inFlight,
  })
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 20000, label: '慢响应批次到达' })
  const slowC = await state()
  check('网页：慢响应批次到达后只追加，当前歌曲仍是同一首', slowC.currentId === t1.id && slowC.paused === false && slowC.autoQueueIds.length > 0, {
    currentId: slowC.currentId,
    autoQueueIds: slowC.autoQueueIds,
  })


}
export async function pausedResult(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4000 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（暂停用例）' })
  await click('暂停') // 暂停
  await waitFor(async () => (await state()).paused === true, { timeout: 10000, label: '暂停生效' })
  const pausedAt = await state()
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 20000, label: '暂停期间批次到达' })
  await sleep(1200)
  const afterLate = await state()
  check('网页：暂停期间到达的补歌结果只追加，不会自动出声', afterLate.paused === true && Math.abs(afterLate.currentTime - pausedAt.currentTime) < 1.2 && afterLate.autoQueueIds.length > 0, {
    paused: afterLate.paused,
    timeDelta: +(afterLate.currentTime - pausedAt.currentTime).toFixed(2),
    autoQueueIds: afterLate.autoQueueIds,
    prepStatus: afterLate.prepStatus,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-11-paused-late-result.png') })
  await click('继续') // 恢复，确认仍可继续
  await waitFor(async () => (await state()).paused === false, { timeout: 15000, label: '暂停后恢复播放' })


}
export async function stoppedResult(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 3500 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（停止用例）' })
  await click('停止')
  await waitFor(async () => (await state()).sessionId === null, { timeout: 15000, label: '停止生效' })
  await sleep(4200) // 等旧批次在服务端完成
  const afterStop = await state()
  const orch = await api('/api/_test/orchestrator-state')
  check('网页：停止后旧补歌结果不会追加到队列，也不会污染下一次会话', afterStop.sessionId === null && afterStop.paused === true && afterStop.autoQueueIds.length === 0 && (Array.isArray(orch.inflight) ? orch.inflight.length : -1) === 0, {
    sessionId: afterStop.sessionId,
    paused: afterStop.paused,
    autoQueueIds: afterStop.autoQueueIds,
    inflight: (Array.isArray(orch.inflight) ? orch.inflight.length : -1),
    prepStatus: afterStop.prepStatus,
  })


}
