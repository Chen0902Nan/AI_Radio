import { parseSession, parseAdjustment, parseFeedback, parseLibrary } from '@radio/contracts'
import { click, state, track, playing, openRadio, waitState } from './browser-probe.mts'
import type { ProbeContext } from './probe-runner.mts'

async function lifecycle({ env, check }: ProbeContext): Promise<void> {
  await env.request('/api/session/stop', {})
  check('停止后没有开放会话', parseSession(await env.request('/api/session')).session === null)
  const first = parseSession(await env.request('/api/session/start', {})).session!
  const second = parseSession(await env.request('/api/session/start', {})).session!
  check('重复开播复用会话', first.id === second.id)
  const adjusted = parseAdjustment(await env.request('/api/session/adjustment', { key: 'mood', value: '轻松' }))
  check('临时调整保存在当前会话', adjusted.adjustments.mood === '轻松')
  await env.request('/api/session/stop', {})
  const next = parseSession(await env.request('/api/session/start', {})).session!
  check('停止后新会话清空临时调整', next.id !== first.id && Object.keys(next.adjustments).length === 0)
}
async function feedback(ctx: ProbeContext): Promise<void> {
  const { env, check } = ctx
  const selected = parseLibrary(await env.request('/api/library')).liked.tracks[0]
  if (!selected) throw new Error('曲库为空，缺少反馈样本')
  const body = { trackId: selected.id, trackName: selected.name, artists: selected.artists }
  await env.request('/api/feedback', { ...body, sentiment: 'like' })
  await env.request('/api/feedback', { ...body, sentiment: 'dislike' })
  const active = parseFeedback(await env.request('/api/feedback')).active.filter(row => row.track_id === selected.id)
  check('同曲反馈替换后只有一个生效', active.length === 1 && active[0].sentiment === 'dislike')
  const candidates = await env.request('/api/_test/sample-candidates?n=120')
  if (!Array.isArray(candidates.ids)) throw new Error('候选响应无效')
  check('不喜欢的具体版本从自动候选硬排除', !candidates.ids.includes(selected.id))
  await env.restart()
  check('服务进程重启后反馈仍有效', parseFeedback(await env.request('/api/feedback')).active.some(row => row.track_id === selected.id && row.sentiment === 'dislike'))
  const revoked = await fetch(env.base + '/api/feedback/' + selected.id, { method: 'DELETE' })
  check('反馈可以撤销', revoked.ok && !parseFeedback(await env.request('/api/feedback')).active.some(row => row.track_id === selected.id))
  const restored = await env.request('/api/_test/sample-candidates?n=120')
  check('撤销后该版本恢复进入候选', Array.isArray(restored.ids) && restored.ids.includes(selected.id))
  check('非法反馈被拒绝', (await env.request('/api/feedback', { ...body, sentiment: 'unknown' })).status === 400)
}
async function browserSession(ctx: ProbeContext): Promise<void> {
  const { env, check } = ctx
  await env.request('/api/session/stop', {})
  const page = await openRadio(env), initial = await state(page)
  await track(page, initial.queue[0].trackId); await playing(page)
  const first = await waitState(page, s => s.playId !== null && s.sessionId !== null, '首次记账')
  await click(page, '暂停'); await click(page, '继续'); await playing(page)
  check('暂停恢复会话与记账实例不变', (await state(page)).playId === first.playId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitState(page, s => s.queueLength > 0, '刷新后资料')
  check('刷新不自动出声，也不新建会话', (await state(page)).paused && parseSession(await env.request('/api/session')).session?.id === first.sessionId)
  await track(page, initial.queue[0].trackId); await playing(page)
  await click(page, '喜欢')
  await waitState(page, asyncState => asyncState.status.includes('喜欢'), '喜欢反馈')
  check('浏览器反馈按钮写入服务端', parseFeedback(await env.request('/api/feedback')).active.some(row => row.track_id === initial.queue[0].trackId && row.sentiment === 'like'))
  await click(page, '撤销喜欢')
  await click(page, '停止'); await waitState(page, s => s.sessionId === null, '停止完成')
  await click(page, '开播'); await playing(page)
  const after = await waitState(page, s => s.sessionId !== null, '重开会话')
  check('停止后重新开播建立新会话', after.sessionId !== first.sessionId)
}
export async function sessionScenes(ctx: ProbeContext): Promise<void> {
  await lifecycle(ctx)
  await feedback(ctx)
  await browserSession(ctx)
}
