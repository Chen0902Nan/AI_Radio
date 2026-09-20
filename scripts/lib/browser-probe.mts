import type { Page } from 'puppeteer-core'
import type { TrackItem } from '@radio/contracts'
import type { PlaybackSnapshot } from '../../apps/web/dist-playback/playback/playback-controller.js'
import type { VerificationEnvironment } from './verification-environment.mts'

export interface BrowserState extends PlaybackSnapshot {
  sessionId: string | null; playId: number | null; status: string; prepStatus: string
  queue: TrackItem[]; consecutiveFailures: number; awaitingRefill: boolean
  refill: { state: string; epoch: number; batches: number }
  segue: { state: string; naturalCount: number; epoch: number }
  audioSrc: string
}
export async function waitFor<T>(read: () => Promise<T> | T, label: string, timeout = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value as NonNullable<T>
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`等待超时：${label}`)
}
export async function click(page: Page, label: string): Promise<void> {
  for (const button of await page.$$('button')) {
    if ((await button.evaluate(el => el.textContent.trim())) === label) { await button.click(); return }
  }
  throw new Error(`找不到按钮：${label}`)
}
export async function state(page: Page): Promise<BrowserState> {
  const value: unknown = await page.$eval('[data-radio-observation]', el => JSON.parse((el as HTMLElement).dataset.radioObservation!))
  if (!value || typeof value !== 'object' || !('queue' in value) || !Array.isArray(value.queue) || !('playToken' in value) || typeof value.playToken !== 'number') throw new Error('页面缺少当前版本的只读观察结构')
  // 与 Player 写出的内部只读快照同版本；只在浏览器序列化边界恢复声明。
  const snapshot = value as Omit<BrowserState, 'audioSrc'>
  const media = await page.$eval('audio', a => ({ paused: a.paused, currentTime: a.currentTime, duration: a.duration, audioSrc: a.currentSrc || a.src, readyState: a.readyState }))
  return { ...snapshot, ...media }
}
export async function waitState(page: Page, predicate: (s: BrowserState) => boolean, label: string, timeout?: number): Promise<BrowserState> {
  return waitFor(async () => { const s = await state(page); return predicate(s) ? s : null }, label, timeout)
}
export async function openRadio(env: VerificationEnvironment): Promise<Page> {
  const page = await (await env.browser()).newPage()
  await page.goto(env.base, { waitUntil: 'domcontentloaded' })
  await waitState(page, s => s.queueLength >= 6, '至少6首可播曲目')
  return page
}
export async function track(page: Page, id: number): Promise<void> {
  for (const row of await page.$$('div[title]')) {
    const title = await row.evaluate(el => el.title)
    const s = await state(page), item = s.queue.find(t => t.trackId === id)
    if (item && title === `${item.name} — ${item.artists}${item.album ? ' · ' + item.album : ''}`) { await row.click(); return }
  }
  throw new Error(`当前资料列表找不到歌曲 ${id}`)
}
export async function playing(page: Page, id?: number): Promise<BrowserState> {
  return waitState(page, s => !s.paused && s.currentTime > 0.05 && s.currentKind === 'track' && (id === undefined || s.currentTrackId === id), '歌曲出声')
}
