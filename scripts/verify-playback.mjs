/**
 * 真实浏览器验证：完整歌曲自然播完、点击下一首、单曲失败自动换歌、连续失败停止快速重试。
 *
 * 前置：服务端已用 `npm run start:test` 启动（RADIO_TEST_HOOKS=1），并已登录本人账号。
 * 用法：node scripts/verify-playback.mjs [--headful] [--base=http://127.0.0.1:8787]
 *
 * 证据只记录本项目自己的 /api/* 地址与本机播放状态，不记录任何带鉴权的 CDN 直链或凭据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.scratch/radio-agent/verification/artifacts')
fs.mkdirSync(OUT, { recursive: true })

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8787').split('=')[1]
const HEADLESS = !args.includes('--headful')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const report = { at: new Date().toISOString(), base: BASE, headless: HEADLESS, checks: [], evidence: {} }
const log = (...a) => console.log(...a)

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}

function skipCheck(name, detail) {
  report.skipped = (report.skipped || []).concat([{ name, detail }])
  log(`  SKIP  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 30000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await sleep(interval)
  }
}

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return res.json()
}

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json()
  check('服务端在线并启用故障注入', health.ok === true && health.testHooks === true, {
    loggedIn: health.loggedIn,
    testHooks: health.testHooks,
  })
  if (!health.testHooks) throw new Error('服务端未启用 RADIO_TEST_HOOKS=1，无法做故障注入验证')
  if (!health.loggedIn) throw new Error('未登录：请先在浏览器完成网易云扫码登录')
  report.evidence.account = { nickname: health.account.nickname, userId: health.account.userId }

  // 选一首确认可完整播放的曲目
  const libRes = await (await fetch(BASE + '/api/library')).json()
  const all = libRes.liked.tracks
  log(`红心歌曲 ${all.length} 首，扫描前 30 首以挑选曲目（同时收集无权限样本）…`)
  const fullTracks = []
  const unplayableTracks = []
  for (const t of all.slice(0, 30)) {
    const r = await (await fetch(`${BASE}/api/resolve/${t.id}`)).json()
    if (r.playable) fullTracks.push({ ...t, level: r.level, br: r.br })
    else unplayableTracks.push({ id: t.id, name: t.name, artists: t.artists, kind: r.kind, code: r.code })
  }
  if (!fullTracks.length) throw new Error('前 30 首红心歌曲里没有可完整播放的曲目')
  const primary = fullTracks[0]
  report.evidence.selectedTracks = fullTracks.slice(0, 5).map((t) => ({
    id: t.id, name: t.name, artists: t.artists, durationMs: t.durationMs, level: t.level, br: t.br,
  }))
  report.evidence.unplayableInFirst30 = unplayableTracks
  log(`选中：${primary.name} — ${primary.artists}（${(primary.durationMs / 1000).toFixed(1)}s）；无权限曲目 ${unplayableTracks.length} 首`)

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 900 })

  const trace = []
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/api/audio/') || u.includes('/api/resolve/')) {
      trace.push({ kind: 'request', url: u.replace(BASE, ''), at: Date.now() })
    }
  })
  page.on('response', (res) => {
    const u = res.url()
    if (u.includes('/api/audio/') || u.includes('/api/resolve/')) {
      trace.push({ kind: 'response', url: u.replace(BASE, ''), status: res.status(), at: Date.now() })
    }
  })
  page.on('console', (m) => {
    if (m.type() === 'error') log('  [page error]', m.text())
  })

  const state = () => page.evaluate(() => (window.__radio ? window.__radio.state : null))
  // 关键：只认“audio 元素当前地址就是这首歌”的状态，避免用上一首的进度误判
  const srcMatches = (s, id) => Boolean(s && id && s.audioSrc.includes(`/api/audio/${id}?`))
  const decoded = () =>
    page.evaluate(() => {
      const a = document.querySelector('audio')
      return {
        webkitAudioDecodedByteCount: a.webkitAudioDecodedByteCount,
        networkState: a.networkState,
        errorCode: a.error ? a.error.code : null,
      }
    })

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await waitFor(
    async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())),
    { timeout: 90000, label: '音乐资料加载' },
  )

  // Phase 0：页面加载后不自动出声
  await sleep(1500)
  const s0 = await state()
  check('页面加载后没有自动播放', s0.paused === true && !s0.audioSrc, { paused: s0.paused, src: s0.audioSrc })
  report.evidence.phase0 = { paused: s0.paused, audioSrc: s0.audioSrc, status: s0.status }

  // Phase 1：点击曲目播放完整歌曲
  const rowSel = `#tracks .track[data-id="${primary.id}"]`
  await page.waitForSelector(rowSel)
  await page.click(rowSel)
  // 必须等到 audio 元素真的换成这首歌的地址；否则旧音频的 currentTime 会污染判断
  await waitFor(async () => {
    const s = await state()
    return s && srcMatches(s, primary.id) && !s.paused && s.currentTime > 2
  }, { timeout: 30000, label: '开始播放' })
  await sleep(4000)
  const s1 = await state()
  const d1 = await decoded()
  check('点击后真实播放第一首完整歌曲', s1.currentId === primary.id && s1.currentTime > 2, {
    id: s1.currentId, currentTime: +s1.currentTime.toFixed(2), duration: +s1.duration.toFixed(2),
    decodedBytes: d1.webkitAudioDecodedByteCount, networkState: d1.networkState,
  })
  report.evidence.phase1 = { ...s1, decoded: d1 }
  await page.screenshot({ path: path.join(OUT, 'shot-01-playing.png') })

  // Phase 2：点击下一首
  const beforeNext = await state()
  await page.click('#next')
  await waitFor(async () => {
    const s = await state()
    return s && s.currentId !== beforeNext.currentId && srcMatches(s, s.currentId) && !s.paused && s.currentTime > 1
  }, { timeout: 40000, interval: 500, label: '下一首开始播放' })
  const s2 = await state()
  check('点击下一首切换到另一首可播歌曲', s2.currentId !== beforeNext.currentId && s2.currentTime > 1, {
    from: beforeNext.currentId, to: s2.currentId, title: s2.currentTitle,
    currentTime: +s2.currentTime.toFixed(2),
  })
  report.evidence.phase2 = s2

  // Phase 3：注入单曲失败，验证自动换歌（用请求轨迹量实际退避，不用猜测）
  const beforeFail = await state()
  const traceMark = trace.length
  await post('/api/_test/fail-next', { count: 1 })
  await page.click('#next')
  await waitFor(async () => {
    const s = await state()
    return s && s.failureCount > beforeFail.failureCount
  }, { timeout: 20000, interval: 150, label: '注入失败被记录' })
  const failedState = await state()
  const injectedTrackId = failedState.lastError.id

  // 等待失败后的下一次解析完成并恢复播放
  await waitFor(async () => {
    const s = await state()
    return s && s.currentId !== injectedTrackId && srcMatches(s, s.currentId) && !s.paused && s.currentTime > 1
  }, { timeout: 45000, interval: 500, label: '换歌后恢复播放' })
  const s3 = await state()

  const failedResp = trace.slice(traceMark).find((e) => e.kind === 'response' && e.status === 502)
  const nextResolve = failedResp
    ? trace.slice(traceMark).find((e) => e.kind === 'request' && e.at > failedResp.at && e.url.startsWith('/api/resolve/'))
    : null
  const backoffMs = failedResp && nextResolve ? nextResolve.at - failedResp.at : null

  check('单曲音源失败后自动换歌并恢复播放', s3.currentTime > 1 && !s3.paused, {
    failedId: injectedTrackId,
    reason: failedState.lastError.reason,
    resumedId: s3.currentId,
    resumedTitle: s3.currentTitle,
  })
  check('失败后不是立即重试（有约 1.2s 退避）', backoffMs !== null && backoffMs >= 1000, { backoffMs })
  report.evidence.phase3 = { injectedTrackId, failedState: failedState.lastError, resumed: s3, backoffMs }
  await page.screenshot({ path: path.join(OUT, 'shot-02-after-failure.png') })

  // Phase 3b：真实无播放权限的曲目（非注入）——必须明确区分并跳过
  if (unplayableTracks.length) {
    const ut = unplayableTracks[0]
    await page.click(`#tracks .track[data-id="${ut.id}"]`)
    await waitFor(async () => {
      const s = await state()
      return s && s.lastError && s.lastError.id === ut.id
    }, { timeout: 25000, interval: 200, label: '真实无权限曲目被标记' })
    const su = await state()
    check('真实无权限曲目被明确标记为不可播放并跳过', /无播放权限|试听/.test(su.lastError.reason), {
      id: ut.id, name: ut.name, artists: ut.artists, kind: ut.kind, reason: su.lastError.reason,
    })
    await waitFor(async () => {
      const s = await state()
      return s && s.currentId !== ut.id && srcMatches(s, s.currentId) && !s.paused && s.currentTime > 1
    }, { timeout: 45000, interval: 500, label: '无权限曲目后恢复播放' })
    const sr = await state()
    check('无权限曲目之后继续播放可播曲目', sr.currentTime > 1 && !sr.paused, {
      resumedId: sr.currentId, resumedTitle: sr.currentTitle,
    })
    report.evidence.phase3b = { unplayable: ut, reason: su.lastError.reason, resumed: sr }
  } else {
    skipCheck('真实无权限曲目被明确标记为不可播放并跳过', {
      why: '前 30 首红心歌曲里没有无权限曲目样本',
    })
    skipCheck('无权限曲目之后继续播放可播曲目', { why: '同上' })
  }

  // Phase 4：连续失败后停止快速重试
  const beforeBurst = await state()
  await post('/api/_test/fail-next', { count: 20 })
  const tBurst = Date.now()
  await page.click('#next')
  await waitFor(async () => {
    const s = await state()
    return s && s.consecutiveFailures >= 3
  }, { timeout: 30000, interval: 200, label: '连续失败计数达到 3' })
  const tStop = Date.now()
  await sleep(8000)
  const afterWait = await state()
  const attemptsDelta = afterWait.resolveAttempts - beforeBurst.resolveAttempts
  check('连续 3 首失败后停止自动换歌并说明原因', afterWait.consecutiveFailures >= 3 && /连续/.test(afterWait.status), {
    status: afterWait.status,
    consecutiveFailures: afterWait.consecutiveFailures,
    newFailedIds: afterWait.failedIds,
    stoppedAfterMs: tStop - tBurst,
  })
  check('停止后不再继续快速重试', attemptsDelta <= 4, {
    resolveAttemptsBefore: beforeBurst.resolveAttempts,
    resolveAttemptsAfter: afterWait.resolveAttempts,
    delta: attemptsDelta,
    observeMs: tStop - tBurst + 8000,
  })
  report.evidence.phase4 = { status: afterWait.status, consecutiveFailures: afterWait.consecutiveFailures, attemptsDelta }
  await page.screenshot({ path: path.join(OUT, 'shot-03-stopped.png') })

  // 清掉剩余注入，避免影响完整播放
  await post('/api/_test/fail-next', { count: 0 })

  // Phase 5：完整歌曲从头自然播放到结束（不拖动进度、不加速）
  const restart = primary
  log(`完整播放：${restart.name}（约 ${(restart.durationMs / 1000).toFixed(0)}s），等待自然结束…`)
  const rowSel2 = `#tracks .track[data-id="${restart.id}"]`
  await page.click(rowSel2)
  await waitFor(async () => {
    const s = await state()
    return s && srcMatches(s, restart.id) && !s.paused && s.currentTime > 0.5 && s.currentTime < 20
  }, { timeout: 40000, interval: 300, label: '重新开始播放完整曲目' })

  const samples = []
  const startWall = Date.now()
  const startState = await state()
  // 权威时长取歌单资料里的时长；结束事件里的 duration 用来交叉核对
  const expectedDuration = restart.durationMs / 1000
  const playerDuration = startState.duration
  let endedEvent = null
  let monotonic = true
  let lastTime = startState.currentTime

  const deadline = Date.now() + expectedDuration * 1000 + 120000
  while (Date.now() < deadline) {
    const s = await state()
    const ev = await page.evaluate(() => window.__radio.events || [])
    endedEvent = ev.find((e) => e.type === 'ended' && e.id === restart.id) || null
    // 结束事件出现时播放头可能已被下一首重置，先不再比较进度
    if (!endedEvent) {
      if (s.currentTime + 0.4 < lastTime) monotonic = false
      if (s.currentTime - lastTime > 12) monotonic = false // 疑似拖动进度或加速
      lastTime = s.currentTime
    }
    samples.push({ t: Date.now() - startWall, currentTime: +s.currentTime.toFixed(2), paused: s.paused, id: s.currentId })
    if (endedEvent) break
    if (s.currentId !== restart.id) break
    await sleep(1500)
  }

  const wallMs = Date.now() - startWall
  const reachedEnd = endedEvent ? endedEvent.currentTime >= endedEvent.duration - 2 : false
  const naturalEnd = Boolean(endedEvent) && reachedEnd
  check('完整歌曲从头自然播放到结束（未拖动进度）', naturalEnd && monotonic, {
    id: restart.id, title: restart.name,
    durationSec: +expectedDuration.toFixed(1),
    playerReportedDurationSec: +playerDuration.toFixed(1),
    endedAtSec: endedEvent ? +endedEvent.currentTime.toFixed(2) : null,
    wallClockSec: +(wallMs / 1000).toFixed(1),
    monotonic,
    sampleCount: samples.length,
  })
  check('播放耗时与真实时长一致（不是加速或跳段）', Math.abs(wallMs / 1000 - expectedDuration) < 30, {
    wallClockSec: +(wallMs / 1000).toFixed(1), durationSec: +expectedDuration.toFixed(1),
  })
  check('播放器时长与曲目真实时长一致（完整歌曲，不是试听片段）', Math.abs(playerDuration - expectedDuration) < 1.5, {
    playerReportedDurationSec: +playerDuration.toFixed(1),
    libraryDurationSec: +expectedDuration.toFixed(1),
  })
  report.evidence.phase5 = {
    track: { id: restart.id, name: restart.name, artists: restart.artists, durationMs: restart.durationMs },
    playerReportedDurationSec: playerDuration,
    samples: samples.filter((_, i) => i % 5 === 0),
    sampleCount: samples.length,
    endedEvent,
    wallClockSec: wallMs / 1000,
    monotonic,
  }
  await page.screenshot({ path: path.join(OUT, 'shot-04-finished.png') })

  // Phase 6：结束后自动续播下一首
  await waitFor(async () => {
    const s = await state()
    return s && s.currentId !== restart.id && srcMatches(s, s.currentId) && !s.paused
  }, { timeout: 60000, interval: 500, label: '结束后自动续播' })
  const s6 = await state()
  check('自然结束后自动续播下一首', s6.currentId !== restart.id && !s6.paused, {
    nextId: s6.currentId, nextTitle: s6.currentTitle,
  })
  report.evidence.phase6 = s6

  report.evidence.networkTrace = trace.map((e) => ({ ...e, at: e.at - trace[0].at }))
  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
    skipped: (report.skipped || []).length,
  }

  await browser.close()
  fs.writeFileSync(path.join(OUT, 'browser-playback.json'), JSON.stringify(report, null, 2), 'utf-8')
  log(`\n结果：${report.summary.passed} 通过 / ${report.summary.failed} 失败 / ${report.summary.skipped} 跳过`)
  log(`证据：${path.relative(ROOT, path.join(OUT, 'browser-playback.json'))}`)
  if (report.summary.failed) process.exitCode = 1
}

main().catch((err) => {
  report.fatal = String(err.stack || err.message)
  fs.writeFileSync(path.join(OUT, 'browser-playback.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.error('验证中止：', err.message)
  process.exitCode = 1
})
