import path from 'node:path'
import type { NaturalPlaybackTrace } from './tool-types.d.ts'
import { isBatchTrackPlaying } from './playback-checks.mts'
import type { BrowserContext } from './orchestration-browser-adapter.mts'

export async function exhaustedRecovery(ctx: BrowserContext) {
  const { tracks, post, api, check, waitFor, sleep, setSettings, setConfig, page, OUT, report, state, startPlaying, seekEnd, loadPage, openDb, click } = ctx
  const [t1, t2] = tracks

  await post('/api/_test/codex-mode', { mode: 'success' })
  await setConfig({ threshold: 5, batchSize: 3, backoffBaseMs: 800, backoffMaxMs: 800, maxAttempts: 2 })
  await post('/api/_test/refill-forced', {
    code: 'candidates_exhausted',
    message: '（测试注入）排除当前与已排队歌曲后没有新候选',
    count: 9,
  })
  await startPlaying([t1.id])
  await waitFor(
    async () => (await state()).refill.state === 'waiting_recovery',
    { timeout: 20000, interval: 250, label: '进入等待恢复' },
  )
  const exhaustedUi = await state()
  const attemptsAtLimit = exhaustedUi.refill.attempts
  await sleep(2500)
  const exhaustedAfter = await state()
  check(
    '网页：候选不足时给出明确状态并进入等待恢复（不再自动重试）',
    exhaustedUi.refill.state === 'waiting_recovery' &&
      /候选不足|补歌已暂停|没有可完整播放/.test(exhaustedUi.prepStatus) &&
      exhaustedAfter.refill.attempts === attemptsAtLimit,
    {
      state: exhaustedUi.refill.state,
      attempts: attemptsAtLimit,
      attemptsAfterWait: exhaustedAfter.refill.attempts,
      prepStatus: exhaustedUi.prepStatus,
    },
  )
  await post('/api/_test/refill-forced', { count: 0 })
  await setConfig({ threshold: 1, batchSize: 3, backoffBaseMs: 30000, maxAttempts: 5 })


}
