import assert from 'node:assert/strict'
import type { Page } from 'puppeteer-core'
import type { VerificationEnvironment } from './verification-environment.mts'

export interface DjObservation {
  index: number; sessionId: string | null; queueLength: number; userWantsPlayback: boolean
  segue: { state: string; naturalCount: number; stopped: boolean; paused: boolean }
}
export interface MediaSnapshot { src: string; paused: boolean; time: number; duration: number }
export interface SmokeContext { env: VerificationEnvironment; page: Page; resolveRequests: string[] }
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export async function waitFor<T>(fn: () => Promise<T>, label: string, timeout = 12000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  throw new Error(`等待超时：${label}`)
}
export async function observation(page: Page): Promise<DjObservation> {
  const value: unknown = await page.$eval('[data-radio-observation]', el => JSON.parse((el as HTMLElement).dataset.radioObservation || '{}'))
  assert.ok(value && typeof value === 'object' && 'index' in value && 'segue' in value)
  // The observation is a read-only diagnostic surface owned by Player; no playback commands are exposed.
  return value as DjObservation
}
export const media = (page: Page): Promise<MediaSnapshot> => page.$eval('audio', a => ({ src: a.src, paused: a.paused, time: a.currentTime, duration: a.duration }))
export async function click(page: Page, label: string): Promise<void> {
  for (const button of await page.$$('button')) {
    if ((await button.evaluate(el => el.textContent.trim())).startsWith(label)) { await button.click(); return }
  }
  throw new Error(`找不到按钮：${label}`)
}
export async function reset(ctx: SmokeContext): Promise<void> {
  await ctx.env.request('/api/session/stop', {})
  await ctx.env.request('/api/_test/fish-mode', { mode: 'success', delayMs: 0 })
  await ctx.env.request('/api/_test/dj-script-mode', { mode: 'success', delayMs: 0 })
  await ctx.env.request('/api/settings', { key: 'djEnabled', value: 'true' })
  await ctx.env.request('/api/settings', { key: 'djIntervalTracks', value: '3' })
  await ctx.page.goto(ctx.env.base, { waitUntil: 'domcontentloaded' })
  await waitFor(async () => (await observation(ctx.page)).queueLength >= 6, '隔离曲库已显示')
  await click(ctx.page, '红心歌曲')
  await waitFor(async () => (await observation(ctx.page)).index === -1, '手动曲库已选择')
}
export async function play(ctx: SmokeContext, index = 0): Promise<void> {
  if (index === 0) await click(ctx.page, '开播')
  else await ctx.page.locator(`div[title="验证歌曲${index + 1} — 验证歌手"]`).click()
  await waitTrack(ctx.page, index)
}
export async function waitTrack(page: Page, index: number): Promise<void> {
  await waitFor(async () => {
    const state = await observation(page), audio = await media(page)
    return state.index === index && audio.src.includes('/api/audio/') && !audio.paused && audio.time > 0.05
  }, `第 ${index + 1} 首实际播放`)
}
export async function seekEnd(page: Page): Promise<void> {
  await page.$eval('audio', audio => { if (!Number.isFinite(audio.duration)) throw new Error('音频时长未知'); audio.currentTime = Math.max(0, audio.duration - 0.08) })
}
export async function driveToSegue(ctx: SmokeContext): Promise<void> {
  await play(ctx)
  for (const index of [1, 2]) { await seekEnd(ctx.page); await waitTrack(ctx.page, index) }
  await waitFor(async () => (await observation(ctx.page)).segue.state === 'ready', 'DJ 就绪')
  assert.equal((await observation(ctx.page)).segue.naturalCount, 2)
  await seekEnd(ctx.page)
  await waitFor(async () => { const a = await media(ctx.page); return a.src.includes('/api/dj/audio/') && !a.paused && a.time > 0.05 }, 'DJ 实际播放')
}
export async function toggleDj(page: Page, enabled: boolean): Promise<void> {
  const checkbox = await page.$('input[type="checkbox"]')
  assert.ok(checkbox)
  if ((await checkbox.evaluate(el => el.checked)) !== enabled) await checkbox.click()
}
export async function preview(ctx: SmokeContext, delayMs = 0): Promise<void> {
  await ctx.env.request('/api/_test/fish-mode', { mode: 'success', delayMs })
  const input = await ctx.page.$('input[placeholder^="音色 reference_id"]')
  assert.ok(input)
  await input.evaluate(el => el.select()); await input.press('Backspace'); await input.type('fixture-preview-' + Date.now())
  await click(ctx.page, '试听')
}
export async function nextWithEvent(page: Page, event: 'ended' | 'error', replay = false): Promise<void> {
  await page.evaluate(({ type, same }) => {
    const target = same ? document.querySelector<HTMLElement>('div[title="验证歌曲2 — 验证歌手"]')
      : Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === '下一首')
    if (!target) throw new Error('切歌控件缺失')
    target.click(); document.querySelector('audio')!.dispatchEvent(new Event(type))
  }, { type: event, same: replay })
}
