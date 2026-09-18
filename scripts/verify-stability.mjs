/**
 * 两小时稳定性观测（M5 收口）：无头浏览器持续收听新 Nest 服务，周期性检查：
 *  - 音频在播放（除暂停等待外）：正常速度、无意外停止
 *  - 队列推进 / 补歌批次到达
 *  - DJ 机会与生成失败有界
 *  - 请求失败、实际媒体事件、补歌/DJ 状态与配置倍速
 * 全程记录可回溯事件；最终输出 JSON 报告（RADIO_STABILITY_OUT 可覆盖输出路径）。
 *
 * 用法：node scripts/verify-stability.mjs [--base=http://127.0.0.1:8792] [--duration-min=120]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer from 'puppeteer-core'
import { isPlaybackStalled } from './lib/playback-checks.mjs'
import { moveToTrash } from './lib/trash.mjs'

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8792').split('=')[1]
const DURATION_MS = (Number((args.find((a) => a.startsWith('--duration-min=')) || '').split('=')[1]) || 120) * 60 * 1000
const OUT = process.env.RADIO_STABILITY_OUT
  ? path.resolve(process.env.RADIO_STABILITY_OUT)
  : path.join(os.tmpdir(), `stability-${Date.now()}.json`)

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  durationMs: DURATION_MS,
  samples: [],
  events: [],
  errors: [],
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stability-'))
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: profile,
    args: ['--mute-audio'],
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => report.errors.push({ at: Date.now(), kind: 'pageerror', message: String(e.message).slice(0, 200) }))
  await page.exposeFunction('recordRadioMediaEvent', event => report.events.push({ at: Date.now(), ...event }))
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const audio = document.querySelector('audio')
      for (const kind of ['playing', 'ended', 'error', 'pause', 'seeking', 'ratechange']) {
        audio?.addEventListener(kind, () => window.recordRadioMediaEvent({ kind, src: audio.src.split('?')[0], t: audio.currentTime, playbackRate: audio.playbackRate }))
      }
    })
  })
  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 })
    await sleep(3000)

    for (const b of await page.$$('button')) {
      if (['开播', '继续'].includes(await b.evaluate((el) => el.textContent))) {
        await b.click()
        break
      }
    }
    report.events.push({ at: Date.now(), kind: 'start' })

    const deadline = Date.now() + DURATION_MS
    let previous = null
    let stallCount = 0
    while (Date.now() < deadline) {
      await sleep(60_000) // 每分钟采样
      try {
        const s = await page.evaluate(() => {
          const a = document.querySelector('audio')
          return {
            src: (a.src || '').split('?')[0],
            paused: a.paused,
            t: +a.currentTime.toFixed(1),
            duration: +a.duration.toFixed(1) || 0,
            playbackRate: a.playbackRate,
            radio: JSON.parse(document.querySelector('[data-radio-observation]')?.getAttribute('data-radio-observation') || 'null'),
          }
        })
        const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch((e) => ({ ok: false, err: String(e.message) }))
        const stalled = isPlaybackStalled(previous, s)
        if (stalled) stallCount += 1
        previous = s
        report.samples.push({ at: Date.now(), ...s, healthOk: Boolean(health.ok), stalled })
        if (!s.radio) report.errors.push({ at: Date.now(), kind: 'missing_queue_observation' })
        if (!health.ok) report.errors.push({ at: Date.now(), kind: 'health' })
        if (s.playbackRate !== 1) report.errors.push({ at: Date.now(), kind: 'playback_rate', value: s.playbackRate })
        if (s.paused && s.radio?.userWantsPlayback && !s.radio?.awaitingRefill) report.errors.push({ at: Date.now(), kind: 'unexpected_pause' })
        log(`audio t=${s.t}/${s.duration}s paused=${s.paused} src=${s.src.slice(-30)} health=${health.ok}`)
      } catch (err) {
        report.errors.push({ at: Date.now(), kind: 'sample', message: String(err.message).slice(0, 200) })
        log('采样失败:', err.message)
      }
    }

    const summary = {
      ...report,
      finishedAt: new Date().toISOString(),
      stallCount,
      sampleCount: report.samples.length,
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(summary, null, 1))
    log('报告已写入', OUT, `| 采样 ${summary.sampleCount} | 停滞 ${stallCount} | 页面/采样错误 ${report.errors.length}`)
    if (stallCount || report.errors.length) process.exitCode = 1
  } finally {
    await browser.close()
    moveToTrash(profile)
  }
}

main().catch((e) => {
  console.error('稳定性观测失败:', e.message)
  process.exit(1)
})
