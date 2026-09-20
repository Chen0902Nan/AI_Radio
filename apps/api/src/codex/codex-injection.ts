import type { CodexCandidate, PickResponse } from './codex-types'

let injectedMode = 'off'
let injectedDelayMs = 0
// 调用计数：用于验证「同一会话不会并发生成多批」和「冷却期不消耗订阅」。
const stats = { calls: 0, injected: 0, lastMode: 'off', lastAt: null as string | null }

export function setCodexMode(mode: string, { delayMs }: { delayMs?: number } = {}): string {
  injectedMode = mode || 'off'
  if (delayMs !== undefined) injectedDelayMs = Math.max(0, Number(delayMs) || 0)
  stats.lastMode = injectedMode
  return injectedMode
}
export function getCodexMode(): string {
  return injectedMode
}
export function getStats(): Record<string, unknown> {
  return { ...stats, mode: injectedMode, delayMs: injectedDelayMs }
}
export function resetStats(): void {
  stats.calls = 0
  stats.injected = 0
  stats.lastAt = null
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const INJECTED_RAW: Record<string, { picks: Array<{ id?: number | null; reason: string }> }> = {
  // 全是编造的 id：应被校验全部拒绝，最终判为输出无效
  invalid: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: -5, reason: '负数 id' }] },
  // 一半编造、一半真实：真实部分应保留，编造部分应被丢弃并记录
  partial: { picks: [{ id: 111111111, reason: '编造的 id' }, { id: null, reason: '缺 id' }] },
}

/** 仅测试注入用：从候选里取 n 首真实的，模拟「部分合法」的模型输出。 */
function pickRealFor(candidates: CodexCandidate[], n: number) {
  return candidates.slice(0, n).map((c) => ({ id: c.id, reason: '（测试注入）真实候选' }))
}


export function recordCall(started: number): void {
  stats.calls += 1
  stats.lastAt = new Date(started).toISOString()
  if (process.env.RADIO_TEST_HOOKS === '1' && injectedMode !== 'off') stats.injected += 1
}
export async function injectedPicks(candidates: CodexCandidate[], wanted: number, timeoutMs: number, started: number, meta: Record<string, unknown>): Promise<PickResponse | null> {
  if (process.env.RADIO_TEST_HOOKS !== '1' || injectedMode === 'off') return null
  if (injectedMode === 'slow') await sleep(injectedDelayMs || 4000)
  if (['slow', 'success'].includes(injectedMode)) return { raw: { picks: pickRealFor(candidates, wanted) }, meta }
  if (injectedMode === 'invalid') return { raw: INJECTED_RAW.invalid, meta }
  if (injectedMode === 'partial') return { raw: { picks: [...INJECTED_RAW.partial.picks, ...pickRealFor(candidates, 2)] }, meta }
  if (!['timeout', 'quota'].includes(injectedMode)) return null
  const message = injectedMode === 'timeout' ? `（测试注入）Codex 超过 ${timeoutMs}ms 未返回` : '（测试注入）Codex 订阅额度/速率受限'
  return { failure: { ok: false, code: injectedMode, message, meta: { ...meta, durationMs: Date.now() - started, injected: true } } }
}
