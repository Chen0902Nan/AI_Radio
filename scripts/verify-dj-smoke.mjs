/**
 * DJ 串场浏览器冒烟（任务 06 离线部分）：注入模式下验证 歌→DJ→歌、计数、控制与界面。
 * 末尾「复核回归」段覆盖复核发现的 6 项前端问题（迟到试听、旧媒体 ended、停止后重开、
 * DJ 暂停恢复、暂停中的媒体错误、关闭 DJ 开关）。
 *
 * 前置：服务端已用 `npm run start:test` 启动（RADIO_TEST_HOOKS=1），并已登录本人账号。
 * 用法：node scripts/verify-dj-smoke.mjs [--headful] [--base=http://127.0.0.1:8787]
 *
 * 注入说明：dj-script/fish 均走 RADIO_TEST_HOOKS 注入模式（success），不调用真实
 * Codex/Fish；真实验证归 07/08。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.scratch/dj-segue/verification/artifacts')
fs.mkdirSync(OUT, { recursive: true })

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8787').split('=')[1]
const HEADLESS = !args.includes('--headful')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const report = { at: new Date().toISOString(), base: BASE, headless: HEADLESS, checks: [] }
const log = (...a) => console.log(...a)
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
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

const trackArgs = (tracks) =>
  tracks.map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, durationMs: t.durationMs }))
const radioState = (page) => page.evaluate(() => window.__radio.state)

function playTrack(page, index) {
  return page.evaluate((i) => document.querySelectorAll('.track')[i].click(), index)
}
function seekEnd(page) {
  return page.evaluate(() => window.__radio.__test.seekToEnd())
}
function waitTrackPlaying(page, index) {
  return waitFor(
    () => page.evaluate((i) => {
      const s = window.__radio.state
      return s.index === i && s.currentTime > 0.3 && !s.paused
    }, index),
    { timeout: 40000, label: `第 ${index + 1} 首出声` },
  )
}
function setDjEnabled(page, checked) {
  return page.evaluate((v) => {
    const box = document.getElementById('djEnabled')
    box.checked = v
    box.dispatchEvent(new Event('change'))
  }, checked)
}
/**
 * 重置为可控队列并自然播完 3 首（interval=3），让串场真正出声。
 * 每次调用都会作废旧机会并从 0 计数，复核场景之间互不干扰。
 */
async function driveToSegue(page, tracks) {
  await page.evaluate((ts) => {
    window.__radio.__test.replaceQueue(ts)
    window.__radio.__test.djApplyConfig({ djEnabled: true, djIntervalTracks: 3 })
  }, trackArgs(tracks))
  await playTrack(page, 0)
  await waitTrackPlaying(page, 0)
  for (const i of [1, 2]) {
    await seekEnd(page)
    await waitTrackPlaying(page, i)
  }
  await waitFor(() => page.evaluate(() => window.__radio.state.dj.state === 'ready'), { timeout: 60000, label: '串场就绪' })
  await seekEnd(page)
  await waitFor(
    () => page.evaluate(() => window.__radio.state.currentKind === 'segue' && window.__radio.state.currentTime > 0.2),
    { timeout: 30000, label: '串场出声' },
  )
  return radioState(page)
}

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json()
  if (!health.testHooks) throw new Error('服务端未启用 RADIO_TEST_HOOKS=1')
  if (!health.loggedIn) throw new Error('未登录：请先扫码登录')

  // 注入：文案与语音直接成功，不调用真实服务
  await post('/api/_test/dj-script-mode', { mode: 'success' })
  await post('/api/_test/fish-mode', { mode: 'success' })

  // 挑两首确认可完整播放的歌
  const libRes = await (await fetch(BASE + '/api/library')).json()
  const all = libRes.liked.tracks
  const fullTracks = []
  for (const t of all.slice(0, 30)) {
    const r = await (await fetch(`${BASE}/api/resolve/${t.id}`)).json()
    if (r.playable) fullTracks.push(t)
    if (fullTracks.length >= 6) break // 复核回归里的串场场景需要 6 首可控曲目
  }
  if (fullTracks.length < 6) throw new Error('可完整播放的曲目不足 6 首')
  log(`使用曲目：${fullTracks.map((t) => t.name).join(' / ')}`)

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  })
  const page = await browser.newPage()
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' })
  await page.waitForFunction('window.__radio && window.__radio.state.queueLength > 0', { timeout: 30000 })

  // 构造可控队列（2 首），打开 DJ
  await page.evaluate((tracks) => {
    window.__radio.__test.replaceQueue(tracks)
    document.getElementById('djEnabled').checked = true
    document.getElementById('djEnabled').dispatchEvent(new Event('change'))
  }, fullTracks.slice(0, 2).map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, durationMs: t.durationMs })))

  // 把间隔临时调成 1 首一播？控制器只接受 3/4/5 —— 用语义：播完 3 首才 DJ。
  // 但队列只有 2 首 → 改为 4 首队列并补到 3 首结束。直接放 3 首：第 3 首结束后计数=3=interval-1 准备，
  // 第 4 首…队列不足。所以直接断言准备行为后，用第一首结束后准备、第二首结束后播放？计数语义固定 interval=4。
  // 更直接的验证：队首开始后手动把 djIntervalTracks 调成 3，播 3 首需要 3 首队列。放 3 首。
  await page.evaluate((tracks) => {
    window.__radio.__test.replaceQueue(tracks)
    window.__radio.__test.djApplyConfig({ djEnabled: true, djIntervalTracks: 3 })
  }, fullTracks.slice(0, 3).map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, durationMs: t.durationMs })))

  // 开播（点第一首）
  await page.click('.track')
  const s1 = await waitFor(() => page.evaluate(() => window.__radio.state.paused === false && window.__radio.state.currentTime > 0.3), { timeout: 30000, label: '第一首出声' })
  check('第一首歌曲实际出声', s1)

  // 第 1、2 首自然结束（计数累计）
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.__radio.__test.seekToEnd())
    // 等待 index 前进且新曲目真正出声（不能用 currentTime 判断，老曲尾部同样 > 0.3）
    await waitFor(
      () => page.evaluate((idx) => window.__radio.state.index === idx && window.__radio.state.currentTime > 0.3 && !window.__radio.state.paused, i + 1),
      { timeout: 40000, label: `第 ${i + 2} 首出声` },
    )
    const dj = await page.evaluate(() => window.__radio.state.dj)
    check(`第 ${i + 2} 首进入时计数正确`, dj.naturalCount === i + 1, { naturalCount: dj.naturalCount })
  }

  // 第 3 首进入 → 计数=2=interval-1 → 应已发起准备
  await waitFor(() => page.evaluate(() => ['preparing', 'ready'].includes(window.__radio.state.dj.state)), { timeout: 20000, label: '提前准备发起' })
  check('进入第 3 首时提前准备串场（interval-1）', true)
  await waitFor(() => page.evaluate(() => window.__radio.state.dj.state === 'ready'), { timeout: 60000, label: '注入模式下就绪' })
  check('注入模式下串场就绪（未调用真实 Codex/Fish）', true)

  // 第 3 首自然结束 → 应播 DJ
  await page.evaluate(() => window.__radio.__test.seekToEnd())
  await waitFor(() => page.evaluate(() => window.__radio.state.currentKind === 'segue' && window.__radio.state.currentTime > 0.2), { timeout: 30000, label: 'DJ 出声' })
  const segueState = await page.evaluate(() => ({
    kind: window.__radio.state.currentKind,
    segue: window.__radio.state.segue,
    title: document.getElementById('title').textContent,
    segueTarget: document.getElementById('segueTarget').textContent,
    sources: document.querySelectorAll('#segueSources .src-link').length,
    likeDisabled: document.getElementById('like').disabled,
  }))
  check('歌曲自然结束后播出 DJ 串场（同一音频出口）', segueState.kind === 'segue')
  // 复核 1：歌名/歌手必须一路带到生成器（音源接口不返回名称，客户端不传就只剩「曲目 <id>」）
  // 目标可能是补歌补进来的下一首，所以从队列条目实际读，不写死第几首
  const djTargetName = await page.evaluate(
    (itemId) => {
      const row = document.querySelector(`.track[data-item-id="${itemId}"] .tn`)
      return row ? row.textContent : ''
    },
    segueState.segue && segueState.segue.targetItemId,
  )
  check(
    '[复核 1] 串场目标带着真实歌名与歌手，而不是「曲目 <id>」',
    Boolean(djTargetName) && segueState.segueTarget.startsWith(djTargetName) && !segueState.segueTarget.includes('曲目'),
    { segueTarget: segueState.segueTarget, expectedName: djTargetName },
  )
  check('界面显示串场目标、文案与可点击来源', segueState.segue && segueState.segue.scriptText.length > 0 && segueState.sources >= 1, {
    title: segueState.title,
    sources: segueState.sources,
  })
  check('串场期间歌曲反馈按钮禁用', segueState.likeDisabled === true)
  check('串场音频走同源 /api/dj/audio/ 地址', segueState.segue && segueState.segue.audioUrl.startsWith('/api/dj/audio/'))

  // DJ 中点下一首：直接进入目标歌曲
  await page.click('#next')
  await waitFor(() => page.evaluate(() => window.__radio.state.currentKind === 'track' && !window.__radio.state.paused), { timeout: 30000, label: '跳过 DJ 进目标歌' })
  const afterSkip = await page.evaluate(() => ({ kind: window.__radio.state.currentKind, count: window.__radio.state.dj.naturalCount, title: document.getElementById('title').textContent }))
  check('DJ 中点下一首直接进入目标歌曲', afterSkip.kind === 'track')
  check('DJ 已出声被跳过 → 计数已清零（本轮算使用）', afterSkip.count === 0, { naturalCount: afterSkip.count })

  // 停止收听 → 清空
  await page.click('#stop')
  await sleep(500)
  const stopped = await page.evaluate(() => window.__radio.state.dj)
  check('停止收听后串场状态清空', stopped.stopped === true && stopped.naturalCount === 0)

  /* ---------- 复核回归（9 项问题里落在前端状态与事件的 6 项） ---------- */

  log('\n— 复核回归 —')
  const R = fullTracks.slice(0, 6)

  // 每个场景独立跑完：某个场景的等待超时不能掩盖其他场景的结论。
  async function scenario(name, fn) {
    log(`\n[场景] ${name}`)
    try {
      await fn()
    } catch (err) {
      check(`${name} —— 场景中断`, false, { error: err.message })
    }
  }

  // [问题 4] 停止收听后再开播：必须建立新会话与新播放记录，且仍从原位置继续
  await scenario('复核 4 · 停止后重开', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await playTrack(page, 1)
    await waitTrackPlaying(page, 1)
    await sleep(1500) // 让它真的播一会儿，位置才有意义
    await page.click('#stop')
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '已停止收听' })
    const atStop = await radioState(page)
    await page.click('#play')
    await waitFor(
      () => page.evaluate(() => Boolean(window.__radio.state.sessionId) && Boolean(window.__radio.state.playId)),
      { timeout: 20000, label: '重开后拿到会话与播放记录' },
    )
    const restarted = await page.evaluate(() => ({
      sessionId: window.__radio.state.sessionId,
      playId: window.__radio.state.playId,
      index: window.__radio.state.index,
      title: window.__radio.state.currentTitle,
      time: window.__radio.state.currentTime,
      stopDisabled: document.getElementById('stop').disabled,
    }))
    check('[复核 4] 停止后开播建立新会话', Boolean(restarted.sessionId) && restarted.sessionId !== atStop.sessionId, {
      before: atStop.sessionId,
      after: restarted.sessionId,
    })
    check('[复核 4] 新会话下有新的歌曲播放记录，「停止」按钮可用', Boolean(restarted.playId) && restarted.stopDisabled === false, {
      playId: restarted.playId,
    })
    check(
      '[复核 4] 仍从原位置继续，不重头播这首歌',
      restarted.index === atStop.index && restarted.title === atStop.currentTitle && restarted.time >= atStop.currentTime,
      { index: restarted.index, time: restarted.time },
    )
  })

  // [问题 2] 切歌解析期间到达的旧媒体 ended 不能被算成新歌的自然结束
  await scenario('复核 2 · 旧媒体的遗留 ended', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await playTrack(page, 1)
    await waitTrackPlaying(page, 1)
    const beforeSongSwitch = await radioState(page)
    await page.evaluate(() => {
      document.getElementById('next').click()
      // 同一次任务里派发遗留 ended：此刻媒体里装的还是上一首
      document.getElementById('audio').dispatchEvent(new Event('ended'))
    })
    // 只等“换歌后确实出声”，具体落在第几首交给断言判断（跳过头时要看到失败而不是超时）
    await waitFor(
      () => page.evaluate((i) => {
        const s = window.__radio.state
        return s.index > i && !s.paused && s.currentTime > 0.3
      }, beforeSongSwitch.index),
      { timeout: 40000, label: '换歌后出声' },
    )
    await sleep(500)
    const afterSongSwitch = await radioState(page)
    check('[复核 2] 切歌解析期间旧媒体的 ended 不跳歌', afterSongSwitch.index === beforeSongSwitch.index + 1, {
      index: afterSongSwitch.index,
    })
    check(
      '[复核 2] 切歌解析期间旧媒体的 ended 不错误计数',
      afterSongSwitch.dj.naturalCount === beforeSongSwitch.dj.naturalCount,
      { count: afterSongSwitch.dj.naturalCount },
    )
  })

  // [问题 3] 试听合成期间开始收听并暂停：迟到的试听结果不能替换媒体、不能越过暂停
  await scenario('复核 3 · 迟到试听', async () => {
    await page.click('#stop')
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '再次停止' })
    await post('/api/_test/fish-mode', { mode: 'success', delayMs: 3000 })
    // 每次用新的候选音色：命中试听缓存时响应会立刻返回，复现不出“迟到结果”
    await page.evaluate((ref) => {
      document.getElementById('previewVoice').value = ref
      document.getElementById('previewBtn').click()
    }, `voice-review-${Date.now()}`)
    await waitFor(() => page.evaluate(() => document.getElementById('djStatus').textContent.includes('正在合成试听')), {
      timeout: 5000,
      label: '试听请求已发出',
    })
    await playTrack(page, 0) // 合成还没回来就开始收听
    await waitTrackPlaying(page, 0)
    await page.click('#play') // 再暂停，检验迟到结果会不会越过暂停
    await waitFor(() => page.evaluate(() => window.__radio.state.paused === true), { timeout: 10000, label: '收听中暂停' })
    await sleep(3500) // 等迟到的试听响应
    const latePreview = await page.evaluate(() => ({
      previewing: window.__radio.state.previewing,
      loadedTrackId: window.__radio.state.loadedTrackId,
      currentId: window.__radio.state.currentId,
      paused: window.__radio.state.paused,
      djStatus: document.getElementById('djStatus').textContent,
    }))
    check(
      '[复核 3] 迟到的试听结果被丢弃，不替换歌曲媒体',
      latePreview.previewing === false && latePreview.loadedTrackId === latePreview.currentId,
      { loadedTrackId: latePreview.loadedTrackId, currentId: latePreview.currentId },
    )
    check(
      '[复核 3] 迟到试听不越过暂停、不打断收听',
      latePreview.paused === true && !latePreview.djStatus.includes('试听播放中'),
      { paused: latePreview.paused, djStatus: latePreview.djStatus },
    )
    await post('/api/_test/fish-mode', { mode: 'success' })
  })

  // [问题 5 + 问题 2] DJ 暂停恢复后控制器必须解除暂停；DJ 换下后的 ended 不能跳过新歌
  await scenario('复核 5 · DJ 暂停恢复', async () => {
    await driveToSegue(page, R)
    await page.click('#play') // 暂停 DJ
    await waitFor(() => page.evaluate(() => window.__radio.state.paused === true), { timeout: 10000, label: 'DJ 已暂停' })
    check('[复核 5] DJ 暂停时控制器同步进入暂停', (await radioState(page)).dj.paused === true)
    await page.click('#play') // 从原位置恢复
    await waitFor(
      () => page.evaluate(() => window.__radio.state.paused === false && window.__radio.state.dj.paused === false),
      { timeout: 15000, label: 'DJ 已恢复' },
    )
    check('[复核 5] DJ 恢复后控制器解除暂停（否则之后不再准备串场）', true)

    const beforeDjSkip = await radioState(page)
    await page.evaluate(() => {
      document.getElementById('next').click()
      // 此刻媒体里装的是刚被换下的 DJ 音频
      document.getElementById('audio').dispatchEvent(new Event('ended'))
    })
    await waitFor(
      () => page.evaluate((i) => {
        const s = window.__radio.state
        return s.index > i && s.currentKind === 'track' && !s.paused && s.currentTime > 0.3
      }, beforeDjSkip.index),
      { timeout: 40000, label: '跳过 DJ 后出声' },
    )
    await sleep(500)
    const afterDjSkip = await radioState(page)
    check('[复核 2] 旧 DJ 的 ended 不跳过新歌', afterDjSkip.index === beforeDjSkip.index + 1, { index: afterDjSkip.index })
    check(
      '[复核 2] 旧 DJ 的 ended 不错误计数',
      afterDjSkip.dj.naturalCount === beforeDjSkip.dj.naturalCount,
      { count: afterDjSkip.dj.naturalCount },
    )
  })

  // [问题 6] DJ 暂停后收到媒体错误：不能自动播放下一首、不能覆盖暂停
  await scenario('复核 6 · 暂停中的媒体错误', async () => {
    await driveToSegue(page, R)
    const beforeDjError = await radioState(page)
    await page.click('#play')
    await waitFor(() => page.evaluate(() => window.__radio.state.paused === true), { timeout: 10000, label: 'DJ 已暂停' })
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('error')))
    await sleep(800)
    const afterDjError = await radioState(page)
    check(
      '[复核 6] DJ 暂停后媒体错误不自动播放下一首',
      afterDjError.paused === true && afterDjError.userWantsPlayback === false,
      { paused: afterDjError.paused, userWantsPlayback: afterDjError.userWantsPlayback },
    )
    check(
      '[复核 6] 只切到目标歌曲待播状态（保持暂停）',
      afterDjError.currentKind === 'track' && afterDjError.segue === null && afterDjError.index === beforeDjError.index + 1,
      { index: afterDjError.index, status: afterDjError.status },
    )
  })

  // [问题 7] 关闭 DJ 开关：暂停中只切到目标歌曲待播；播报中则结束播报进入后续歌曲
  await scenario('复核 7 · 关闭 DJ 开关', async () => {
    await driveToSegue(page, R)
    const beforeDjOffPaused = await radioState(page)
    await page.click('#play')
    await waitFor(() => page.evaluate(() => window.__radio.state.paused === true), { timeout: 10000, label: 'DJ 已暂停' })
    await setDjEnabled(page, false)
    await sleep(800)
    const offWhilePaused = await radioState(page)
    check(
      '[复核 7] 暂停中关闭 DJ：保持暂停，只切到目标歌曲待播',
      offWhilePaused.paused === true && offWhilePaused.segue === null && offWhilePaused.index === beforeDjOffPaused.index + 1,
      { paused: offWhilePaused.paused, index: offWhilePaused.index },
    )

    await driveToSegue(page, R)
    const beforeDjOffPlaying = await radioState(page)
    await setDjEnabled(page, false)
    // 播报长约 20 秒：只等 2.5 秒，能通过就说明是开关结束的，而不是自然播完
    await sleep(2500)
    const offWhilePlaying = await radioState(page)
    check(
      '[复核 7] 播报中关闭 DJ：立即结束播报并进入目标歌曲',
      offWhilePlaying.currentKind === 'track' &&
        offWhilePlaying.segue === null &&
        offWhilePlaying.paused === false &&
        offWhilePlaying.index === beforeDjOffPlaying.index + 1,
      { index: offWhilePlaying.index, kind: offWhilePlaying.currentKind, paused: offWhilePlaying.paused },
    )
  })

  // [复核 3 的对照组] 没有竞争时，正常试听必须照常出声：守卫不能把试听一起挡掉
  await scenario('复核 3b · 正常试听仍可用', async () => {
    await page.click('#stop')
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '停止收听以便试听' })
    await post('/api/_test/fish-mode', { mode: 'success' })
    await page.evaluate((ref) => {
      document.getElementById('previewVoice').value = ref
      document.getElementById('previewBtn').click()
    }, `voice-review-ok-${Date.now()}`)
    await waitFor(() => page.evaluate(() => window.__radio.state.previewing === true && !window.__radio.state.paused), {
      timeout: 20000,
      label: '试听正常出声',
    })
    const previewing = await page.evaluate(() => ({
      previewing: window.__radio.state.previewing,
      loadedTrackId: window.__radio.state.loadedTrackId,
      title: document.getElementById('title').textContent,
      djStatus: document.getElementById('djStatus').textContent,
    }))
    check(
      '[复核 3b] 正常试听照常播出（守卫不误伤）',
      previewing.previewing === true && previewing.loadedTrackId === null && previewing.title === '音色试听',
      { title: previewing.title, loadedTrackId: previewing.loadedTrackId },
    )
    // 收尾：结束试听状态，避免污染后续场景
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')))
    await sleep(300)
  })

  /* ---------- 复核第二轮（4 项） ---------- */

  log('\n— 复核第二轮 —')

  // [问题 1] 发起试听 → 开播 → 停止：迟到的试听不能出声（停止后会话又是 null）
  await scenario('复核二 1 · 停止后迟到试听', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await page.click('#stop')
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '已停止收听' })
    await post('/api/_test/fish-mode', { mode: 'success', delayMs: 3000 })
    await page.evaluate((ref) => {
      document.getElementById('previewVoice').value = ref
      document.getElementById('previewBtn').click()
    }, `voice-r2-${Date.now()}`)
    await waitFor(() => page.evaluate(() => document.getElementById('djStatus').textContent.includes('正在合成试听')), {
      timeout: 5000,
      label: '试听请求已发出',
    })
    await playTrack(page, 1) // 合成期间开播
    await waitTrackPlaying(page, 1)
    await page.click('#stop') // 又停止：播放意图是关的
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '再次停止收听' })
    await sleep(4000) // 等迟到的试听响应返回
    const afterStop1 = await page.evaluate(() => ({
      previewing: window.__radio.state.previewing,
      paused: window.__radio.state.paused,
      loadedTrackId: window.__radio.state.loadedTrackId,
      currentId: window.__radio.state.currentId,
      status: window.__radio.state.status,
    }))
    check(
      '[复核二 1] 停止后迟到的试听不出声、不替换媒体',
      afterStop1.paused === true && afterStop1.previewing === false && afterStop1.loadedTrackId === afterStop1.currentId,
      {
        paused: afterStop1.paused,
        previewing: afterStop1.previewing,
        loadedTrackId: afterStop1.loadedTrackId,
        currentId: afterStop1.currentId,
      },
    )
    await post('/api/_test/fish-mode', { mode: 'success', delayMs: 0 })
  })

  // [问题 2] 试听中点歌：必须退出试听模式，新歌要记播放历史、自然结束要接下一首
  await scenario('复核二 2 · 试听中点歌', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await page.click('#stop')
    await waitFor(() => page.evaluate(() => window.__radio.state.sessionId === null), { timeout: 10000, label: '已停止收听' })
    await page.evaluate((ref) => {
      document.getElementById('previewVoice').value = ref
      document.getElementById('previewBtn').click()
    }, `voice-r2b-${Date.now()}`)
    // 必须等试听真正在走（currentTime 前进）：只判断 !paused 时 play() 可能还没兑现，
    // 那种情况下切歌会走异常分支，反而掩盖问题
    await waitFor(
      () => page.evaluate(() => window.__radio.state.previewing === true && window.__radio.state.currentTime > 0.2),
      { timeout: 20000, label: '试听真正在播' },
    )
    await playTrack(page, 2) // 试听中点歌
    await waitTrackPlaying(page, 2)
    await sleep(800)
    const afterPick = await page.evaluate(() => ({
      previewing: window.__radio.state.previewing,
      playId: window.__radio.state.playId,
      index: window.__radio.state.index,
    }))
    check(
      '[复核二 2] 试听中点歌：退出试听模式并记下播放历史',
      afterPick.previewing === false && Boolean(afterPick.playId),
      { previewing: afterPick.previewing, playId: afterPick.playId },
    )
    // 自然结束要接下一首，而不是停在原地
    await seekEnd(page)
    await sleep(2000)
    const afterEnd = await radioState(page)
    check('[复核二 2] 试听中点歌后，歌曲自然结束仍接下一首', afterEnd.index === afterPick.index + 1, {
      index: afterEnd.index,
      expected: afterPick.index + 1,
    })
  })

  // [问题 3] 重新点同一首歌：旧播放实例的 ended 不能跳歌、不能计数
  await scenario('复核二 3 · 重播同一首歌', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await playTrack(page, 1)
    await waitTrackPlaying(page, 1)
    const beforeReplay = await radioState(page)
    await page.evaluate((i) => {
      // 重新点同一首歌：解析期间派发上一次播放实例遗留的 ended（trackId 完全相同）
      document.querySelectorAll('.track')[i].click()
      document.getElementById('audio').dispatchEvent(new Event('ended'))
    }, beforeReplay.index)
    await sleep(2000)
    const afterReplay = await radioState(page)
    check('[复核二 3] 重播同一首歌时旧实例的 ended 不跳歌', afterReplay.index === beforeReplay.index, {
      index: afterReplay.index,
      expected: beforeReplay.index,
    })
    check(
      '[复核二 3] 重播同一首歌时旧实例的 ended 不计数',
      afterReplay.dj.naturalCount === beforeReplay.dj.naturalCount,
      { count: afterReplay.dj.naturalCount },
    )
    check('[复核二 3] 重播后歌曲照常出声', afterReplay.paused === false && afterReplay.currentTime > 0.1, {
      paused: afterReplay.paused,
      currentTime: afterReplay.currentTime,
    })
  })

  // [问题 4] DJ 被换下期间旧音频报错：不能去刷新、失败尚未播放的新歌
  await scenario('复核二 4 · 旧媒体的错误事件', async () => {
    await driveToSegue(page, R)
    const beforeStaleError = await radioState(page)
    await page.evaluate(() => {
      document.getElementById('next').click()
      // 此刻媒体里装的是刚被换下的 DJ 音频，它的报错不属于新歌
      document.getElementById('audio').dispatchEvent(new Event('error'))
    })
    await waitFor(
      () => page.evaluate((i) => {
        const s = window.__radio.state
        return s.currentKind === 'track' && s.index > i && !s.paused && s.currentTime > 0.3
      }, beforeStaleError.index),
      { timeout: 40000, label: '跳过 DJ 后新歌出声' },
    )
    await sleep(500)
    const afterStaleError = await radioState(page)
    check(
      '[复核二 4] 旧媒体的 error 不触发新歌额外刷新',
      afterStaleError.resolveAttempts === beforeStaleError.resolveAttempts + 1,
      { attempts: afterStaleError.resolveAttempts, before: beforeStaleError.resolveAttempts },
    )
    check(
      '[复核二 4] 尚未播放的新歌不被记为失败',
      afterStaleError.failedIds.includes(afterStaleError.currentId) === false,
      { failedIds: afterStaleError.failedIds, currentId: afterStaleError.currentId },
    )
  })

  // [复核二 4 的对照组] 当前媒体真的出错时仍要刷新地址：守卫不能把真实故障一起挡掉
  await scenario('复核二 4b · 当前媒体的真实错误', async () => {
    await page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), trackArgs(R))
    await playTrack(page, 1)
    await waitTrackPlaying(page, 1)
    const beforeRealError = await radioState(page)
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('error')))
    const rightAfter = await radioState(page)
    check(
      '[复核二 4b] 当前媒体的真实 error 仍走刷新路径',
      rightAfter.status.includes('播放中断') || rightAfter.status.includes('刷新'),
      { status: rightAfter.status },
    )
    await waitFor(
      () => page.evaluate((i) => window.__radio.state.resolveAttempts > i, beforeRealError.resolveAttempts),
      { timeout: 20000, label: '真实错误触发刷新' },
    )
    const afterRealError = await radioState(page)
    check(
      '[复核二 4b] 刷新后歌曲继续播放，没有被记为失败或跳歌',
      afterRealError.resolveAttempts > beforeRealError.resolveAttempts &&
        afterRealError.paused === false &&
        afterRealError.index === beforeRealError.index &&
        afterRealError.failedIds.includes(afterRealError.currentId) === false,
      {
        attempts: afterRealError.resolveAttempts,
        before: beforeRealError.resolveAttempts,
        index: afterRealError.index,
        failedIds: afterRealError.failedIds,
      },
    )
  })

  await browser.close()
  const failed = report.checks.filter((c) => !c.ok)
  report.passed = failed.length === 0
  fs.writeFileSync(path.join(OUT, 'dj-smoke.json'), JSON.stringify(report, null, 2))
  log(`\n${report.passed ? '全部通过' : '存在失败'}：${report.checks.filter((c) => c.ok).length}/${report.checks.length}`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟失败：', err.message)
  report.error = err.message
  fs.writeFileSync(path.join(OUT, 'dj-smoke.json'), JSON.stringify(report, null, 2))
  process.exit(1)
})
