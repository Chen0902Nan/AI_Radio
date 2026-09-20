import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { parseLibrary, type LibraryTrack, type TrackItem } from '@radio/contracts'
import type { Page } from 'puppeteer-core'
import type { VerificationEnvironment } from './verification-environment.mts'
import { waitFor, sleep, type Context } from './orchestration-types.mts'
import type { PlaybackSnapshot } from './playback-checks.mts'
import type { NaturalPlaybackTrace } from './tool-types.d.ts'

interface State extends PlaybackSnapshot {
  queueLength: number; sessionId: string | null; awaitingRefill: boolean; audioSrc: string; status: string; prepStatus: string
  refill: { inFlight: boolean; state: string; attempts: number; config: Record<string, number> }
}
interface Observation {
  queue: TrackItem[]; currentTrackId: number | null; loadedTrackId: number | null; queueLength: number
  sessionId: string | null; awaitingRefill: boolean; resolving: boolean; status: string; prepStatus: string
  refill: State['refill']
}
export interface BrowserContext extends Context {
  page: Page; tracks: LibraryTrack[]; OUT: string
  sleep: typeof sleep; waitFor: typeof waitFor
  state(): Promise<State>
  startPlaying(ids: number[]): Promise<State>
  seekEnd(): Promise<void>
  loadPage(): Promise<void>
  click(label: string): Promise<void>
  setSettings(settings: Record<string, unknown>): Promise<void>
  setConfig(config: Record<string, number>): Promise<void>
  openDb(): DatabaseSync
}

export async function createBrowserContext(env: VerificationEnvironment, ctx: Context): Promise<BrowserContext> {
  const browser = await env.browser(), page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 1000 })
  const library = parseLibrary(await env.request('/api/library'))
  const tracks = library.liked.tracks.slice(0, 4)
  assert.ok(tracks.length >= 4, '曲库至少需要 4 首才能完成全部编排场景')
  let selected = tracks
  // Narrow the library HTTP fixture; production queue is populated through its visible source button.
  await page.setRequestInterception(true)
  page.on('request', request => {
    const response = new URL(request.url()).pathname === '/api/library'
      ? request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...library, liked: { count: selected.length, tracks: selected } }) })
      : request.continue()
    void response.catch(() => {})
  })
  const click = (label: string) => clickButton(page, label)
  const loadPage = async () => {
    await page.goto(env.base, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-radio-observation]')
    await waitFor(async () => (await state(page)).queueLength === selected.length, { label: '子曲库加载' })
  }
  const setSettings = async (settings: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(settings)) await env.request('/api/settings', { key, value })
  }
  const startPlaying = async (ids: number[]) => {
    await env.request('/api/session/stop', {})
    selected = ids.map(id => { const track = tracks.find(t => t.id === id); assert.ok(track); return track })
    await loadPage(); await click('红心歌曲')
    await traceNatural(page, ids[0]); await click('开播')
    await waitFor(async () => { const s = await state(page); return s.sessionId && !s.paused && s.currentTime > 0.1 }, { label: '开始播放' })
    return state(page)
  }
  const map: Record<string, string> = { threshold: 'refillThreshold', batchSize: 'refillBatchSize', backoffBaseMs: 'refillBackoffBaseMs', backoffMaxMs: 'refillBackoffMaxMs', maxAttempts: 'refillMaxAttempts' }
  return { ...ctx, page, tracks, OUT: env.paths.root, sleep, waitFor, click, loadPage, startPlaying, setSettings,
    state: () => state(page), seekEnd: () => seekEnd(page), openDb: () => new DatabaseSync(env.paths.db, { readOnly: true }),
    async setConfig(config) { await setSettings(Object.fromEntries(Object.entries(config).map(([key, value]) => [map[key], String(value)]))); await loadPage() },
  }
}
async function clickButton(page: Page, label: string): Promise<void> {
  for (const button of await page.$$('button')) {
    if ((await button.evaluate(el => el.textContent.trim())).startsWith(label)) { await button.click(); return }
  }
  throw new Error(`找不到按钮：${label}`)
}
async function state(page: Page): Promise<State> {
  return page.$eval('[data-radio-observation]', element => {
    const observation: Observation = JSON.parse((element as HTMLElement).dataset.radioObservation || '{}')
    const audio = document.querySelector('audio')!
    if (!Array.isArray(observation.queue) || typeof observation.queueLength !== 'number') throw new Error('只读观察面缺失队列')
    return { queueLength: observation.queueLength, sessionId: observation.sessionId, awaitingRefill: observation.awaitingRefill,
      currentId: observation.currentTrackId || 0, loadedId: observation.loadedTrackId || 0,
      autoQueueIds: observation.queue.filter(t => t.auto).map(t => t.trackId), currentTime: audio.currentTime,
      paused: audio.paused, stopped: observation.sessionId === null, ended: audio.ended, resolving: observation.resolving,
      readyState: audio.readyState, audioSrc: audio.getAttribute('src') || '', status: observation.status, prepStatus: observation.prepStatus,
      refill: observation.refill,
    }
  })
}
async function seekEnd(page: Page): Promise<void> {
  await waitFor(() => page.$eval('audio', a => Number.isFinite(a.duration) && a.duration > 0 && a.readyState >= 2 && !a.paused), { label: '音频就绪' })
  await page.$eval('audio', a => { a.currentTime = Math.max(0, a.duration - 0.08) })
}
async function traceNatural(page: Page, trackId: number): Promise<void> {
  await page.evaluate(id => {
    const audio = document.querySelector('audio')!
    const trace: NaturalPlaybackTrace = { trackId: id, start: null, end: null, seeks: [], rateChanges: [] }
    window.__naturalPlayback = trace
    const loadedId = () => Number((audio.currentSrc || audio.src).match(/\/api\/audio\/(\d+)/)?.[1])
    const sample = () => ({ id: loadedId(), atMs: performance.now(), currentTime: audio.currentTime, duration: audio.duration, playbackRate: audio.playbackRate })
    const active = () => trace.start && !trace.end && loadedId() === id
    audio.addEventListener('playing', () => { if (!trace.start && loadedId() === id) trace.start = sample() })
    audio.addEventListener('seeking', () => { if (active()) trace.seeks.push(sample()) })
    audio.addEventListener('ratechange', () => { if (active()) trace.rateChanges.push(sample()) })
    audio.addEventListener('ended', () => { if (active()) trace.end = sample() })
  }, trackId)
}
