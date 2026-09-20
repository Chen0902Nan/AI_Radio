import { createRequire } from 'node:module'
import { parsePicks, parseSession } from '@radio/contracts'
import { openRadio, click, state, track, playing, waitFor } from './browser-probe.mts'
import type { ProbeContext } from './probe-runner.mts'
const require = createRequire(import.meta.url)
const { validatePicks }: typeof import('../../apps/api/dist/codex/codex.service.js') = require('../../apps/api/dist/codex/codex.service.js')

function validation({ check }: ProbeContext): void {
  const candidates = [{ id: 1, name: 'A', artists: 'a', album: '' }, { id: 2, name: 'B', artists: 'b', album: '' }]
  const valid = validatePicks({ picks: [{ id: 1, reason: '合法' }, { id: 1, reason: '重复' }, { id: 999, reason: '虚构' }, { id: 2, reason: '' }] }, candidates)
  check('模型输出只保留有理由、候选内、不重复的歌曲', valid.valid.length === 1 && valid.valid[0].id === 1 && valid.rejected.length === 3)
  check('错误容器被识别为结构错误', validatePicks({ nope: [] }, candidates).structurallyInvalid)
  check('非法数字 ID 被拒绝', validatePicks({ picks: [{ id: 'x', reason: '无效' }] }, candidates).valid.length === 0)
}
async function selection(ctx: ProbeContext): Promise<void> {
  const { env, check } = ctx
  const sid = parseSession(await env.request('/api/session/start', {})).session!.id
  const result = await env.request('/api/plan', { sessionId: sid, epoch: 1, brief: '深夜安静', count: 4 })
  const picks = parsePicks(result).picks
  check(`${env.fixture ? '本地模型替身' : '真实模型'}选歌返回有效候选`, result.ok && picks.length > 0 && picks.every(p => p.reason.length > 0))
  for (const pick of picks) check(`选中歌曲 ${pick.id} 有完整可播音源`, (await env.request('/api/resolve/' + pick.id)).playable === true)
  await env.request('/api/_test/codex-mode', { mode: 'partial' })
  const partial = await env.request('/api/plan', { sessionId: sid, epoch: 2, brief: '部分错误', count: 4 })
  check('部分非法模型输出仍返回合法可播歌曲', partial.ok && parsePicks(partial).picks.length > 0)
  await env.request('/api/_test/codex-mode', { mode: 'success' })
  await env.request('/api/session/stop', {})
}
async function browserSelection(ctx: ProbeContext): Promise<void> {
  const { env, check } = ctx
  const page = await openRadio(env), first = (await state(page)).queue[0].trackId
  await track(page, first); await playing(page, first)
  await click(page, '让 Codex 选歌')
  await waitFor(() => page.$eval('main', el => el.textContent.includes('Codex 选出')), '选歌结果')
  check('选歌完成只替换待播部分，当前媒体继续', (await state(page)).currentTrackId === first && !(await state(page)).paused)
  await click(page, '下一首'); await playing(page)
  check('选歌结果可由可见按钮真实播放', (await state(page)).currentTrackId !== first)
  for (const mode of ['timeout', 'quota', 'invalid']) {
    // 新会话清除上个失败的退避，否则后续模式没有真正进入供应商 seam。
    await click(page, '停止'); await click(page, '开播'); await playing(page)
    const before = await state(page)
    await env.request('/api/_test/codex-mode', { mode })
    await click(page, '让 Codex 选歌')
    await waitFor(() => page.$eval('main', el => el.textContent.includes('Codex 暂不可用')), `${mode}失败降级`)
    const after = await state(page)
    check(`${mode}失败有明确降级提示且不中断当前歌曲`, after.currentTrackId === before.currentTrackId && !after.paused)
    await env.request('/api/_test/codex-mode', { mode: 'success' })
  }
}
export async function codexScenes(ctx: ProbeContext): Promise<void> {
  validation(ctx)
  await selection(ctx)
  await browserSelection(ctx)
}
