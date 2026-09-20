import { createRequire } from 'node:module'
import type { RefillBatchRequest } from '../../apps/web/dist-playback/orchestration/refill-controller.js'
import type { Check, Report } from './orchestration-types.mts'
const require = createRequire(import.meta.url)
const { RefillController }: typeof import('../../apps/web/dist-playback/orchestration/refill-controller.js') = require('../../apps/web/dist-playback/orchestration/refill-controller.cjs')
function makeClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { fn, at: now + Math.max(0, ms) })
      return id
    },
    clearTimeout: (id: unknown) => { if (typeof id === 'number') timers.delete(id) },
    pending: () => timers.size,
    advance: (ms: number) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)
        if (!due.length) break
        const [id, t] = due[0]
        timers.delete(id)
        now = t.at
        t.fn()
      }
      now = target
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

export async function runControllerUnitChecks(check: Check, report: Report) {
  const harness = createHarness()
  await thresholdChecks(harness, check)
  await backoffChecks(harness, check)
  await cancellationChecks(harness, check)
  await sessionSwitchChecks(harness, check)
  await unsentChecks(harness, check)
  await duplicateChecks(harness, check)
  harness.c.cancel('completed')
  report.evidence.controllerUnit = { calls: harness.calls.length, statuses: harness.statuses }
}

function createHarness() {
  const clock = makeClock()
  const calls: RefillBatchRequest[] = []
  const batches: Array<Array<Record<string, unknown>>> = []
  const statuses: { text: string; cls: string }[] = []
  const response: { run: (request?: unknown) => Promise<Record<string, unknown>> } = { run: () => Promise.resolve({ ok: true, picks: [{ id: 101, type: 'track' }] }) }

  const c = new RefillController({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    config: { threshold: 1, batchSize: 2, backoffBaseMs: 1000, backoffMaxMs: 4000, maxAttempts: 3 },
    getContext: () => ({ sessionId: 's1', playing: true, stopped: false, pending: 0, brief: '' }),
    getExclusion: () => [9],
    requestBatch: (req: RefillBatchRequest) => {
      calls.push(req)
      return response.run(req)
    },
    onBatch: (picks: Array<Record<string, unknown>>) => {
      batches.push(picks)
      return picks.length
    },
    onStatus: (text: string, cls: string) => statuses.push({ text, cls }),
  })

  return { c, clock, calls, batches, statuses, response }
}

async function thresholdChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 阈值与在途去重
  c.check()
  const during = c.check()
  await flush()
  check('控制器：待播不足且正在收听时触发一次补歌', calls.length === 1 && batches.length === 1, {
    calls: calls.length,
    batches: batches.length,
    exclusion: calls[0] && calls[0].excludeIds,
  })
  check('控制器：在途期间重复触发不会重复生成', during === false && calls.length === 1, { secondCheck: during })
  check('控制器：结果通过 onBatch 只交给追加逻辑（不替换队列）', batches[0][0].id === 101)

  // 阈值之上不触发
  c.getContext = () => ({ sessionId: 's1', playing: true, stopped: false, pending: 3 })
  check('控制器：待播充足时不触发补歌', c.check() === false, { pending: 3, threshold: c.config.threshold })

}

async function backoffChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 指数退避 + 上限
  c.getContext = () => ({ sessionId: 's1', playing: true, stopped: false, pending: 0 })
  response.run = () => Promise.resolve({ ok: false, code: 'quota', message: '额度受限' })
  c.check()
  await flush()
  const s1 = c.snapshot()
  check('控制器：失败后进入退避（不是紧密重试）', s1.state === 'backoff' && s1.attempts === 1 && s1.nextRetryAt - clock.now() === 1000, {
    state: s1.state,
    attempts: s1.attempts,
    delayMs: s1.nextRetryAt - clock.now(),
  })
  clock.advance(1000)
  await flush()
  const s2 = c.snapshot()
  clock.advance(2000)
  await flush()
  const s3 = c.snapshot()
  check('控制器：退避按 1s→2s 递增，达到最大次数后等待恢复', s2.attempts === 2 && s3.state === 'waiting_recovery' && s3.attempts === 3, {
    afterSecond: { attempts: s2.attempts, delayMs: s2.nextRetryAt - (clock.now() - 1000) },
    afterThird: { state: s3.state, attempts: s3.attempts },
  })
  const callsAtRecovery = calls.length
  clock.advance(60 * 60 * 1000)
  await flush()
  check('控制器：等待恢复后不再自动重试（不用无限重试掩盖问题）', calls.length === callsAtRecovery && c.snapshot().state === 'waiting_recovery', {
    callsBefore: callsAtRecovery,
    callsAfterAnHour: calls.length,
  })
  c.resume()
  response.run = () => Promise.resolve({ ok: true, picks: [{ id: 202, type: 'track' }] })
  c.check()
  await flush()
  check('控制器：用户动作可以从等待恢复中重新拉起补歌', calls.length === callsAtRecovery + 1 && batches.length === 2, {
    calls: calls.length,
    batches: batches.length,
  })

}

async function cancellationChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 取消作废迟到结果
  let release
  response.run = () => new Promise((r) => (release = r))
  c.check()
  await flush() // 让 requestBatch 真正被调用，拿到 release
  const epochBefore = c.snapshot().epoch
  c.cancel('stopped', { reset: true })
  release!({ ok: true, picks: [{ id: 303, type: 'track' }] })
  await flush()
  check('控制器：取消后迟到的补歌结果不会落到队列上', batches[batches.length - 1][0].id === 202 && c.snapshot().epoch === epochBefore + 1, {
    lastBatch: batches[batches.length - 1][0].id,
    epochBefore,
    epochAfter: c.snapshot().epoch,
  })

  // 新意图作废旧结果
  response.run = () => Promise.resolve({ ok: false, code: 'superseded', message: '被新意图取代' })
  const attemptsBefore = c.snapshot().attempts
  c.check()
  await flush()
  check('控制器：被新意图取代的结果按“作废”处理，不计为失败重试', c.snapshot().state === 'idle' && c.snapshot().attempts === attemptsBefore, {
    state: c.snapshot().state,
    attempts: c.snapshot().attempts,
  })

}

async function sessionSwitchChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 会话失效但客户端已换新会话：不能停在旧结果上，应再试一次
  let ctxSession = { sessionId: 'old', playing: true, stopped: false, pending: 0 }
  c.getContext = () => ctxSession
  let seq2 = 0
  batches.length = 0
  response.run = () => {
    seq2 += 1
    if (seq2 === 1) return Promise.resolve({ ok: false, code: 'session_ended', message: '会话已结束' })
    return Promise.resolve({ ok: true, picks: [{ id: 404, type: 'track' }] })
  }
  c.check()
  ctxSession = { sessionId: 'new', playing: true, stopped: false, pending: 0 }
  await flush()
  await flush()
  check('控制器：服务端会话失效但客户端已换新会话时，会再试一次而不是停住', batches.length === 1 && batches[0][0].id === 404 && seq2 === 2, {
    calls: seq2,
    batches: batches.length,
  })

}

async function unsentChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 本地取消后，尚未发出的请求不应该真的发往服务端
  let lateCalls = 0
  c.getContext = () => ({ sessionId: 's2', playing: true, stopped: false, pending: 0 })
  response.run = () => {
    lateCalls += 1
    return Promise.resolve({ ok: true, picks: [{ id: 505, type: 'track' }] })
  }
  c.check()
  c.cancel('stopped', { reset: true }) // 在请求发出前就取消
  await flush()
  check('控制器：本地取消后，过期的补歌请求不会发往服务端', lateCalls === 0, { calls: lateCalls })

}

async function duplicateChecks(h: ReturnType<typeof createHarness>, check: Check) {
  const { c, clock, calls, batches, response } = h
  // 结果与待播全部重复（实际追加 0 首）：按失败处理，走退避
  batches.length = 0
  response.run = () => Promise.resolve({ ok: true, picks: [{ id: 606, type: 'track' }, { id: 607, type: 'track' }] })
  c.onBatch = () => 0 // 模拟前端把返回结果全部过滤掉
  const attemptsBeforeDup = c.snapshot().attempts
  c.check()
  await flush()
  const dupState = c.snapshot()
  check('控制器：实际追加 0 首时按失败处理（退避重试，不假装补充成功）', dupState.attempts === attemptsBeforeDup + 1 && dupState.state === 'backoff' && batches.length === 0, {
    attempts: dupState.attempts,
    state: dupState.state,
    batches: batches.length,
  })
  c.onBatch = (picks: Array<Record<string, unknown>>) => {
    batches.push(picks)
    return picks.length
  }

}
