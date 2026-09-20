import type { BrowserContext } from './orchestration-browser-adapter.mts'
import { naturalContinuation, waitingRefill, historyContinuation } from './orchestration-browser-natural.mts'
import { slowPreparation, pausedResult, stoppedResult } from './orchestration-browser-intent.mts'
import { refreshSession, quickSkip, degradedContinuation } from './orchestration-browser-recovery.mts'
import { exhaustedRecovery } from './orchestration-browser-exhaustion.mts'
export async function runBrowserChecks(ctx: BrowserContext) {
  const { setSettings, loadPage, state, check } = ctx
  // 让客户端配置与设置一致（验证设置真的驱动补歌参数）
  await setSettings({ refillThreshold: '1', refillBatchSize: '3', refillBackoffBaseMs: '1000', refillMaxAttempts: '3' })
  await loadPage()
  const cfg = (await state()).refill.config
  check('网页：补歌参数来自本地设置（阈值/批量/退避）', cfg.threshold === 1 && cfg.batchSize === 3 && cfg.backoffBaseMs === 1000, cfg)


  await naturalContinuation(ctx)
  await waitingRefill(ctx)
  await historyContinuation(ctx)
  await slowPreparation(ctx)
  await pausedResult(ctx)
  await stoppedResult(ctx)
  await refreshSession(ctx)
  await quickSkip(ctx)
  await degradedContinuation(ctx)
  await exhaustedRecovery(ctx)
}
