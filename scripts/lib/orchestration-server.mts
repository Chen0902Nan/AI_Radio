import { sleep, object, list, sessionId, type Context } from './orchestration-types.mts'

export async function runServerChecks(ctx: Context): Promise<void> {
  await ordering(ctx)
  await exclusion(ctx)
  await failureAndCooldown(ctx)
  await stopInflight(ctx)
}
async function start(ctx: Pick<Context, 'post'>): Promise<string> {
  await ctx.post('/api/session/stop')
  return sessionId(await ctx.post('/api/session/start'))
}
async function ordering({ post, api, check }: Context): Promise<void> {
  const id = await start({ post })
  const refill = (epoch: number) => post('/api/queue/refill', { sessionId: id, epoch, count: 4, excludeIds: [] })
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 300 })
  await post('/api/_test/codex-stats?reset=1')
  const [a, b] = await Promise.all([refill(10), refill(10)])
  const calls = object((await api('/api/_test/codex-stats')).stats).calls
  check('服务端：同会话同意图并发补歌只生成一批', a.ok && b.ok && JSON.stringify(a.picks) === JSON.stringify(b.picks) && calls === 1, { calls })
  const old = refill(20); await sleep(50); const next = refill(21)
  check('服务端：新意图作废旧在途任务', (await old).code === 'superseded' && (await next).ok)
  await post('/api/_test/codex-stats?reset=1')
  const fresh = refill(200); await sleep(50); const stale = await refill(100)
  check('服务端：迟到旧请求不取消新任务', stale.code === 'superseded' && (await fresh).ok)
  const staleAfter = await refill(100)
  check('服务端：新任务完成后仍拒绝旧意图', staleAfter.code === 'superseded' && object((await api('/api/_test/codex-stats')).stats).calls === 1)
  check('服务端：同一意图完成后可以补下一批', (await refill(200)).ok)
  await post('/api/_test/codex-mode', { mode: 'success' })
}
async function exclusion(ctx: Context): Promise<void> {
  const { api, post, check } = ctx
  const id = await start(ctx)
  const library = list(object((await api('/api/library')).liked).tracks)
  const excluded = library.slice(0, 12).map(t => t.id)
  const response = await post('/api/queue/refill', { sessionId: id, epoch: 1, count: 5, excludeIds: excluded })
  const picks = list(response.picks), ids = picks.map(p => p.id)
  check('服务端：排除当前及待播且结果不重复', response.ok && ids.every(id => !excluded.includes(id)) && new Set(ids).size === ids.length)
  check('服务端：每首进队列前完整可播验证', picks.length > 0 && picks.every(p => p.playable === true && p.type === 'track'))
}
async function failureAndCooldown(ctx: Context): Promise<void> {
  const { post, api, check, report } = ctx
  const id = await start(ctx)
  const refill = (epoch: number, excludeIds: unknown[] = []) => post('/api/queue/refill', { sessionId: id, epoch, count: 3, excludeIds })
  await post('/api/_test/codex-mode', { mode: 'timeout' }); await post('/api/_test/codex-stats?reset=1')
  const first = await refill(30), second = await refill(31)
  check('服务端：Codex 超时降级曲库候选', first.ok && first.degraded === true && first.source === 'library' && list(first.picks).every(p => p.playable))
  check('服务端：冷却期间不重复调用 Codex', second.ok && second.reason === 'codex_cooldown' && object((await api('/api/_test/codex-stats')).stats).calls === 1)
  // Exclude the full provider pool, including discovery candidates; liked-only exclusion is no longer exhaustion.
  const library = list(object((await api('/api/library')).liked).tracks).map(t => t.id)
  const exhausted = await refill(32, [...library, ...Array.from({ length: 30 }, (_, i) => 101 + i)])
  check('服务端：候选耗尽明确失败而非伪造结果', exhausted.status === 409 && exhausted.code === 'candidates_exhausted', exhausted)
  await post('/api/_test/codex-mode', { mode: 'success' }); await post('/api/_test/clear-url-cache')
  await post('/api/_test/unplayable-next', { count: 2000 })
  const unavailable = await refill(33)
  check('服务端：全部不可播明确 no_playable', unavailable.code === 'no_playable', unavailable)
  await post('/api/_test/unplayable-next', { count: 0 }); await post('/api/_test/clear-url-cache')
  await post('/api/_test/resolve-error-next', { count: 2000 })
  const failure = await refill(34)
  check('服务端：音乐接口整体错误明确 music_unavailable', failure.code === 'music_unavailable' && failure.status === 503, failure)
  await post('/api/_test/resolve-error-next', { count: 0 })
  report.evidence.server = { degraded: first.reason, cooldown: second.reason, exhausted: exhausted.code }
}
async function stopInflight(ctx: Context): Promise<void> {
  const { post, api, check } = ctx, id = await start(ctx)
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 300 })
  const pending = post('/api/queue/refill', { sessionId: id, epoch: 40, excludeIds: [], count: 3 })
  await sleep(50)
  const stopped = await post('/api/session/stop'), late = await pending
  check('服务端：停止会话作废在途结果', ['superseded', 'session_ended'].includes(String(late.code)) && stopped.ended === true && (await api('/api/session')).session === null)
  await post('/api/_test/codex-mode', { mode: 'success' })
}
export async function runRealCodexRefill(ctx: Context): Promise<void> {
  const { post, check, report } = ctx, id = await start(ctx)
  await post('/api/_test/codex-mode', { mode: 'off' })
  const response = await post('/api/queue/refill', { sessionId: id, epoch: 50, count: 3, excludeIds: [], brief: '傍晚放松，适合一个人安静地听' })
  check('真实 Codex 补歌返回完整可播批次', response.ok && response.source === 'codex' && list(response.picks).length > 0 && list(response.picks).every(p => p.playable))
  report.evidence.realCodex = { picks: response.picks, meta: response.meta }
  await post('/api/session/stop')
}
