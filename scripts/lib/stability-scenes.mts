import { click, openRadio, playing, state } from './browser-probe.mts'
import { isPlaybackStalled } from './playback-checks.mts'
import path from 'node:path'
import type { ProbeContext } from './probe-runner.mts'

function options(): { minutes: number; interval: number } {
  const args = process.argv.slice(2)
  const minutes = Number(args.find(a => a.startsWith('--duration-min='))?.split('=')[1] ?? 120)
  const interval = Number(args.find(a => a.startsWith('--sample-ms='))?.split('=')[1] ?? 60000)
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('观察时长与采样间隔必须为正数')
  return { minutes, interval }
}
function expectedPause(current: Awaited<ReturnType<typeof state>>): boolean {
  return !current.paused || !current.userWantsPlayback || current.awaitingRefill || current.resolving
}
export async function stabilityScenes({ env, check }: ProbeContext): Promise<void> {
  const { minutes, interval } = options()
  const page = await openRadio(env), errors: string[] = [], samples: unknown[] = [], mediaEvents: unknown[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.exposeFunction('recordRadioMediaEvent', (event: unknown) => mediaEvents.push(event))
  await page.evaluate(() => {
    const audio = document.querySelector('audio')!
    for (const kind of ['playing', 'ended', 'error', 'pause', 'seeking', 'ratechange']) audio.addEventListener(kind, () => window.recordRadioMediaEvent({ kind, src: audio.src.split('?')[0], time: audio.currentTime, rate: audio.playbackRate }))
  })
  await click(page, '开播'); await playing(page)
  const deadline = Date.now() + minutes * 60000
  let previous: { src: string; paused: boolean; t: number } | null = null, stalled = 0
  do {
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(1, deadline - Date.now()))))
    const current = await state(page), rate = await page.$eval('audio', a => a.playbackRate)
    const media = { src: current.audioSrc, paused: current.paused, t: current.currentTime }
    if (isPlaybackStalled(previous, media)) stalled++
    previous = media
    const health = await env.request('/api/health')
    samples.push({ at: Date.now(), ...media, rate, radio: current, healthy: health.ok })
    check('稳定性采样：服务在线且媒体使用正常速度', health.ok && rate === 1)
    check('稳定性采样：没有无故暂停', expectedPause(current))
  } while (Date.now() < deadline)
  check('持续播放没有停滞或页面错误', stalled === 0 && errors.length === 0, { samples: samples.length, stalled, errors })
  env.writeReport({ samples, mediaEvents, errors, mode: env.fixture ? 'local-provider-fixtures' : 'real-providers' }, process.env.RADIO_STABILITY_OUT || path.join(process.env.RADIO_REPORT_OUT || path.resolve(import.meta.dirname, '../../.scratch/verification'), 'stability-samples.json'))
}
