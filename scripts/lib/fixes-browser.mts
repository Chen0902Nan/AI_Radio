import assert from 'node:assert/strict'
import type { HTTPRequest, Page } from 'puppeteer-core'
import { click, openRadio, playing, state, track, waitState, waitFor } from './browser-probe.mts'
import type { ProbeContext } from './probe-runner.mts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
interface Delays { next: number[]; requests: string[]; close(): void }
async function delayResolves(page: Page): Promise<Delays> {
  const next: number[] = [], requests: string[] = [], timers = new Set<ReturnType<typeof setTimeout>>()
  await page.setRequestInterception(true)
  const handle = (request: HTTPRequest) => {
    if (!request.url().includes('/api/resolve/')) { void request.continue().catch(() => {}); return }
    requests.push(request.url())
    const delay = next.shift() ?? 0
    if (!delay) { void request.continue().catch(() => {}); return }
    const timer = setTimeout(() => { timers.delete(timer); void request.continue().catch(() => {}) }, delay)
    timers.add(timer)
  }
  page.on('request', handle)
  return { next, requests, close() { page.off('request', handle); for (const timer of timers) clearTimeout(timer); timers.clear() } }
}
function audioId(src: string): number { return Number(/\/api\/audio\/(\d+)/.exec(src)?.[1]) }
async function rapidSelection(page: Page, delays: Delays, ctx: ProbeContext): Promise<void> {
  await track(page, 1); await playing(page, 1)
  delays.next.push(500, 250, 0)
  for (let i = 0; i < 3; i++) { await click(page, '下一首'); await sleep(60) }
  const selected = (await state(page)).currentTrackId
  assert.ok(selected)
  await playing(page, selected)
  await sleep(650)
  const after = await state(page)
  ctx.check('A 快速切歌的迟到结果不覆盖最后选择', after.currentTrackId === selected && audioId(after.audioSrc) === selected)
}
async function loadingPause(page: Page, delays: Delays, ctx: ProbeContext): Promise<void> {
  delays.next.push(400)
  await click(page, '下一首')
  const loading = await waitState(page, s => s.resolving, '解析开始')
  await click(page, '暂停')
  await sleep(550)
  const paused = await state(page)
  ctx.check('B 加载中可暂停，迟到结果不自动出声', paused.paused && !paused.userWantsPlayback && audioId(paused.audioSrc) !== loading.currentTrackId)
  await click(page, '继续')
  assert.ok(loading.currentTrackId)
  const resumed = await playing(page, loading.currentTrackId)
  ctx.check('P1 加载中暂停再恢复，媒体和当前歌曲一致', audioId(resumed.audioSrc) === resumed.currentTrackId)
}
async function manualAfterFailure(page: Page, ctx: ProbeContext): Promise<void> {
  await track(page, 2); await playing(page, 2)
  await ctx.env.request('/api/_test/fail-next', { count: 1 })
  const failed = page.waitForResponse(response => response.url().includes('/api/resolve/') && response.status() === 502)
  await click(page, '下一首'); await failed
  await track(page, 6); await playing(page, 6)
  await sleep(1500)
  const after = await state(page)
  ctx.check('P2 失败后的换歌计时器不覆盖手动选歌', after.currentTrackId === 6 && audioId(after.audioSrc) === 6 && !after.paused)
}
async function pausedStreamFailure(page: Page, delays: Delays, ctx: ProbeContext): Promise<void> {
  await track(page, 1); await playing(page, 1); await click(page, '暂停')
  const before = delays.requests.length
  await ctx.env.request('/api/_test/fail-audio-next', { count: 1 })
  const failed = page.waitForResponse(response => response.url().includes('/api/audio/') && response.status() === 502)
  await page.$eval('audio', audio => {
    audio.preload = 'auto'
    const url = new URL(audio.src); url.searchParams.set('verification', String(Date.now()))
    audio.src = url.toString(); audio.load()
  })
  await failed
  await waitFor(() => delays.requests.length > before, '真实媒体错误触发音源刷新')
  const after = await waitState(page, s => !s.resolving && s.loadedTrackId === s.currentTrackId, '刷新媒体完成')
  ctx.check('P3 真实音频 502 后在暂停状态刷新，保持不出声', after.paused && !after.userWantsPlayback && after.currentTrackId === 1)
}
export async function browserFixes(ctx: ProbeContext): Promise<void> {
  const page = await openRadio(ctx.env)
  const delays = await delayResolves(page)
  try {
    await rapidSelection(page, delays, ctx)
    await loadingPause(page, delays, ctx)
    await manualAfterFailure(page, ctx)
    await pausedStreamFailure(page, delays, ctx)
  } finally { delays.close(); await page.close() }
}
