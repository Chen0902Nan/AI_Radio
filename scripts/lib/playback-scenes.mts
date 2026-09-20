import { click, state, track, playing, waitState, waitFor } from './browser-probe.mts'
import type { ProbeContext } from './probe-runner.mts'
import type { Page } from 'puppeteer-core'

async function singleFailure(ctx: ProbeContext, page: Page): Promise<void> {
  const { env, check } = ctx
  const attempts: number[] = []
  page.on('request', request => { if (request.url().includes('/api/resolve/')) attempts.push(Date.now()) })
  await env.request('/api/_test/fail-next', { count: 1 })
  await click(page, '下一首')
  const failed = await waitState(page, s => s.consecutiveFailures === 1, '单曲失败')
  const next = await waitState(page, s => s.currentTrackId !== failed.currentTrackId && !s.paused && s.currentTime > 0.1, '失败后换歌')
  check('单曲解析失败有提示并自动换歌', next.currentTrackId !== failed.currentTrackId)
  check('自动重试至少退避1秒', attempts.length >= 2 && attempts[1] - attempts[0] >= 1000)
}
async function failureLimit(ctx: ProbeContext, page: Page): Promise<void> {
  const { env, check } = ctx
  await env.request('/api/_test/fail-next', { count: 20 })
  await click(page, '下一首')
  const stopped = await waitState(page, s => s.consecutiveFailures >= 3, '连续失败上限')
  await new Promise(resolve => setTimeout(resolve, 1400))
  const after = await state(page)
  check('连续三首失败后停止自动换歌并提示', after.paused && !after.userWantsPlayback && after.currentTrackId === stopped.currentTrackId && /连续/.test(after.status))
  await env.request('/api/_test/fail-next', { count: 0 })
}
async function naturalPlayback(ctx: ProbeContext, page: Page, id: number): Promise<void> {
  const { check } = ctx
  const events: Array<{ kind: string; time: number; duration: number; rate: number }> = []
  await page.exposeFunction('recordRadioMediaEvent', (event: { kind: string; time: number; duration: number; rate: number }) => events.push(event))
  await page.evaluate(() => {
    const audio = document.querySelector('audio')!
    for (const kind of ['ended', 'seeking', 'ratechange']) audio.addEventListener(kind, () => window.recordRadioMediaEvent({ kind, time: audio.currentTime, duration: audio.duration, rate: audio.playbackRate }))
  })
  await track(page, id)
  const started = await playing(page, id), at = Date.now()
  await waitFor(() => events.find(e => e.kind === 'ended'), '完整自然播放', Math.ceil(started.duration * 1000) + 15000)
  const ended = events.find(e => e.kind === 'ended')!
  check('完整歌曲自然播完且不跳段或加速', ended.time >= ended.duration - 0.2 && events.every(e => e.kind === 'ended' && e.rate === 1))
  check('实际播放耗时与媒体时长相符', Math.abs((Date.now() - at) / 1000 - ended.duration) < 2)
  const next = await waitState(page, s => s.currentTrackId !== id && !s.paused && s.currentTime > 0.05, '自然接下一首')
  check('自然结束自动接下一首', next.currentTrackId !== id)
}
export async function playbackScenes(ctx: ProbeContext, page: Page): Promise<void> {
  const initial = await state(page)
  ctx.check('首载不自动播放', initial.paused && !initial.audioSrc)
  const id = initial.queue[0].trackId
  await track(page, id); await playing(page, id)
  ctx.check('手动点击歌曲真实出声', !(await state(page)).paused)
  await click(page, '下一首')
  ctx.check('手动下一首切换歌曲', (await playing(page)).currentTrackId !== id)
  await singleFailure(ctx, page)
  await failureLimit(ctx, page)
  await naturalPlayback(ctx, page, id)
}
