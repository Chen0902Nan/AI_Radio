/**
 * 针对代码审查发现的三个缺陷做回归验证。
 *
 * 前置：服务端以 `npm run start:test` 启动（RADIO_TEST_HOOKS=1）并已登录本人账号。
 * 用法：node scripts/verify-fixes.mjs [--headful] [--base=http://127.0.0.1:8787]
 *
 * 覆盖：
 *   A 快速连续切歌：迟到的旧解析结果不能覆盖用户最后选择的歌曲
 *   B 加载中暂停：晚到的解析结果不能把播放重新拉起来
 *   C 刷新确认不可播放后：旧音源缓存必须被清除
 *   D 退出登录后：不能命中上一个身份的缓存（会临时备份并恢复 data/session.json）
 *   E 资料读取脚本：资料缺失 / 分页不一致 / 部分查询失败必须导致非零退出
 *
 * 证据只记录本项目的 /api/* 地址与本机播放状态，不含凭据与带鉴权的播放直链。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { collectFailures } from './lib/library-checks.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.scratch/radio-agent/verification/artifacts')
const SESSION_FILE = path.join(ROOT, 'data/session.json')
const SESSION_BACKUP = path.join(ROOT, 'data', '.session.backup.json')
fs.mkdirSync(OUT, { recursive: true })

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8787').split('=')[1]
const HEADLESS = !args.includes('--headful')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const report = { at: new Date().toISOString(), base: BASE, checks: [], evidence: {} }
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}

async function waitFor(fn, { timeout = 30000, interval = 400, label = 'condition' } = {}) {
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

async function resolve(id, force = false) {
  const res = await fetch(`${BASE}/api/resolve/${id}${force ? '?force=1' : ''}`)
  let body = {}
  try {
    body = await res.json()
  } catch (_) {}
  return { status: res.status, ...body }
}

/* ---------------- A / B：播放器并发与暂停 ---------------- */

async function runBrowserChecks() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 900 })

  // 按顺序给接下来的解析请求设定人为延迟：先发出的最慢、最后发出的最快。
  // 这样“旧请求后返回”是确定的，不靠网络抖动也能稳定复现竞争。
  const resolveDelays = []
  const resolveTrace = []
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/api/resolve/')) {
      const id = Number(u.split('/').pop().split('?')[0])
      const ms = resolveDelays.length ? resolveDelays.shift() : 0
      resolveTrace.push({ kind: 'request', id, delayMs: ms, at: Date.now() })
      if (ms > 0) setTimeout(() => req.continue().catch(() => {}), ms)
      else req.continue().catch(() => {})
      return
    }
    req.continue().catch(() => {})
  })
  page.on('response', (res) => {
    const u = res.url()
    if (u.includes('/api/resolve/')) {
      resolveTrace.push({
        kind: 'response',
        id: Number(u.split('/').pop().split('?')[0]),
        status: res.status(),
        at: Date.now(),
      })
    }
  })

  const state = () => page.evaluate(() => (window.__radio ? window.__radio.state : null))
  const srcId = (s) => {
    const m = s && s.audioSrc && s.audioSrc.match(/\/api\/audio\/(\d+)/)
    return m ? Number(m[1]) : null
  }

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await waitFor(
    async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())),
    { timeout: 90000, label: '音乐资料加载' },
  )

  // 先播一首，建立基线
  const firstRow = '#tracks .track:nth-child(1)'
  await page.click(firstRow)
  await waitFor(async () => {
    const s = await state()
    return s && srcId(s) === s.currentId && !s.paused && s.currentTime > 1
  }, { label: '基线播放开始' })
  await sleep(1500)

  /* ---- A：快速连续切歌 ---- */
  const beforeA = await state()
  resolveDelays.push(1600, 800, 0) // 第 1 个请求最晚返回，模拟它被旧结果覆盖
  const tA = Date.now()
  await page.click('#next')
  await sleep(120)
  await page.click('#next')
  await sleep(120)
  await page.click('#next')
  const queuedA = await state()
  await sleep(6000) // 足够让迟到的旧结果返回
  const afterA = await state()
  await sleep(3500)
  const settledA = await state()

  const matchA = srcId(afterA) === afterA.currentId
  check('A 快速连续切歌后，播放器播的就是最后选中的那首（旧请求未覆盖）', matchA, {
    requestedIndex: queuedA.index,
    currentId: afterA.currentId,
    currentTitle: afterA.currentTitle,
    audioSrcId: srcId(afterA),
  })
  check('A 切歌稳定后没有再次被旧结果改动', settledA.currentId === afterA.currentId && srcId(settledA) === srcId(afterA), {
    currentIdAfter3_5s: settledA.currentId,
    audioSrcIdAfter3_5s: srcId(settledA),
  })
  report.evidence.fixA = { before: beforeA, queued: queuedA, after: afterA, settled: settledA, elapsedMs: Date.now() - tA }

  /* ---- B：加载中点暂停 ---- */
  const beforeB = await state()
  resolveDelays.push(1800) // 解析要 1.8s 才回来
  await page.click('#next')
  await sleep(300)
  const duringB = await state()
  check('B 解析中按钮显示“暂停”，用户有取消入口', duringB.resolving === true, {
    resolving: duringB.resolving,
    buttonLabel: await page.$eval('#play', (e) => e.textContent),
  })
  await page.click('#play') // 加载中点暂停
  const afterPauseB = await state()
  await sleep(5000) // 等迟到的解析结果回来
  const afterLateB = await state()

  const lateId = duringB.currentId
  check('B 加载中点暂停后，迟到的解析结果不会把播放重新拉起来', afterLateB.paused === true && srcId(afterLateB) !== lateId, {
    pausedAfter: afterLateB.paused,
    lateTrackId: lateId,
    audioSrcId: srcId(afterLateB),
    userWantsPlayback: afterLateB.userWantsPlayback,
    status: afterLateB.status,
  })
  check('B 暂停后不会再自动播放', afterLateB.userWantsPlayback === false, {
    userWantsPlayback: afterLateB.userWantsPlayback,
    paused: afterLateB.paused,
  })
  report.evidence.fixB = { before: beforeB, during: duringB, afterPause: afterPauseB, afterLate: afterLateB }
  report.evidence.resolveTrace = resolveTrace.map((e) => ({ ...e, at: e.at - resolveTrace[0].at }))

  await browser.close()
}

/* ---------------- C：刷新确认不可播放后清缓存 ---------------- */

async function runCacheInvalidationCheck(trackId) {
  const r1 = await resolve(trackId)
  const r2 = await resolve(trackId)
  check('C 前置：缓存已就绪（重复解析命中缓存）', r2.cached === true, {
    first: { status: r1.status, cached: r1.cached, kind: r1.kind },
    second: { status: r2.status, cached: r2.cached, kind: r2.kind },
  })

  // 注入“刷新后确认不可播放”，它会真的走 resolveTrack 的不可播放分支
  await post('/api/_test/unplayable-next', { count: 1 })
  const r3 = await resolve(trackId, true)
  check('C 强制刷新返回不可播放', r3.status === 200 && r3.playable === false && r3.kind === 'none', {
    status: r3.status,
    kind: r3.kind,
    code: r3.code,
  })

  const r4 = await resolve(trackId)
  check('C 强制刷新确认不可播放后，旧缓存已被清除（不会拿旧地址顶替）', r4.cached === false && r4.kind === 'full', {
    status: r4.status,
    cached: r4.cached,
    kind: r4.kind,
    note: 'cached=true 说明命中了已经不成立的旧条目',
  })
  report.evidence.fixC = { r1, r2, r3, r4 }
}

/* ---------------- D：退出登录后不复用上一个身份的缓存 ---------------- */

async function runIdentityCacheCheck(trackId) {
  let backedUp = false
  try {
    fs.copyFileSync(SESSION_FILE, SESSION_BACKUP)
    backedUp = true
  } catch (err) {
    check('D 前置：能备份会话文件', false, { error: err.message })
    return
  }

  try {
    const a1 = await resolve(trackId)
    const a2 = await resolve(trackId)
    check('D 前置：登录态下第二次解析命中缓存', a2.cached === true && a2.identityKind === 'user', {
      first: { cached: a1.cached, identityKind: a1.identityKind },
      second: { cached: a2.cached, identityKind: a2.identityKind },
    })

    await post('/api/logout', {})
    const b1 = await resolve(trackId)
    const reused = b1.cached === true
    check('D 退出登录后不命中上一个身份的缓存', !reused, {
      status: b1.status,
      cached: b1.cached,
      identityKind: b1.identityKind,
      note: 'cached=true 说明退出登录后仍在用登录态的旧地址',
    })
    report.evidence.fixD = { loggedIn: a2, afterLogout: b1 }
  } finally {
    if (backedUp) {
      fs.copyFileSync(SESSION_BACKUP, SESSION_FILE)
      fs.chmodSync(SESSION_FILE, 0o600)
      fs.unlinkSync(SESSION_BACKUP)
    }
    const restored = await resolve(trackId)
    check('D 会话已恢复，服务重新以登录态解析', restored.identityKind === 'user', {
      status: restored.status,
      identityKind: restored.identityKind,
      cached: restored.cached,
    })
  }
}

/* ---------------- E：资料读取判定逻辑会失败退出 ---------------- */

function runAssertionSelfTest() {
  const clean = {
    liked: { idsReturned: 5, idsUnique: 5, tracksReturned: 5, missingDetails: 0 },
    pagination: { consistent: true },
    playlistTracks: [{ id: 1, name: 'a', complete: true, returned: 3, unique: 3 }],
    playability: { distribution: { full: 3, trial: 0, none: 0, error: 0 } },
    steps: [{ step: 'liked', ok: true }],
  }
  const cases = [
    ['干净报告不应报错', clean, 0],
    ['红心详情缺失', { ...clean, liked: { ...clean.liked, missingDetails: 3 } }, 1],
    ['红心 id 有重复', { ...clean, liked: { ...clean.liked, idsReturned: 6 } }, 1],
    ['分页不一致', { ...clean, pagination: { consistent: false } }, 1],
    ['歌单读取失败', { ...clean, playlistTracks: [{ id: 9, name: 'b', error: 'code=500' }] }, 1],
    ['歌单曲目不完整', { ...clean, playlistTracks: [{ id: 9, name: 'b', complete: false, returned: 1, declaredTrackCount: 5 }] }, 1],
    ['音源查询报错', { ...clean, playability: { distribution: { full: 1, trial: 0, none: 0, error: 2 } } }, 1],
    ['步骤失败', { ...clean, steps: [{ step: 'liked', ok: false }] }, 1],
    ['未登录被阻塞', { ...clean, blocked: '未登录' }, 1],
  ]
  const results = []
  for (const [name, input, expected] of cases) {
    const failures = collectFailures(input)
    results.push({ name, expectedMinFailures: expected, got: failures.length, failures })
  }
  const bad = results.filter((r) => (r.expectedMinFailures === 0 ? r.got !== 0 : r.got < r.expectedMinFailures))
  check('E 判定逻辑自检（合成输入）：异常报告都会被判为失败', bad.length === 0, {
    cases: results.length,
    unexpected: bad,
  })
  report.evidence.fixE = { selfTest: results, note: '合成输入只用于验证断言逻辑本身；真实数据结论以 npm run read-library 的运行结果为准' }
}

/**
 * 真正让资料读取脚本进入失败分支，确认非零退出码会传出去（而不只是报告里写一笔）。
 * 做法是把会话文件暂时移走，让脚本命中“未登录”分支；会立即恢复。
 */
function runExitCodeCheck() {
  const backup = SESSION_FILE + '.selftest-bak'
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-report-'))
  let moved = false
  try {
    fs.renameSync(SESSION_FILE, backup)
    moved = true
  } catch (err) {
    check('E 资料读取脚本在失败时会以非零退出码结束', false, { error: '无法移走会话文件：' + err.message })
    return
  }

  let code = 0
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/read-library.mjs')], {
      stdio: 'ignore',
      env: { ...process.env, RADIO_REPORT_OUT: tmpOut },
    })
  } catch (err) {
    code = err.status
  } finally {
    if (moved) {
      fs.renameSync(backup, SESSION_FILE)
      fs.chmodSync(SESSION_FILE, 0o600)
    }
    fs.rmSync(tmpOut, { recursive: true, force: true })
  }

  check('E 资料读取脚本在失败时会以非零退出码结束（退出码能真的传出去）', code !== 0, { exitCode: code })
}

/* ---------------- main ---------------- */

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json()
  if (!health.ok || !health.testHooks) throw new Error('需要以 RADIO_TEST_HOOKS=1 启动服务')
  if (!health.loggedIn) throw new Error('未登录：请先扫码登录')
  log(`服务在线：${health.account.nickname}\n`)

  const lib = await (await fetch(BASE + '/api/library')).json()
  const probe = lib.liked.tracks.slice(0, 15)
  let target = null
  for (const t of probe) {
    const r = await resolve(t.id)
    if (r.playable) {
      target = t
      break
    }
  }
  if (!target) throw new Error('前 15 首里没有可完整播放的曲目')
  log(`使用曲目：${target.name} — ${target.artists}（id ${target.id}）\n`)

  log('— A / B：播放器并发与暂停 —')
  await runBrowserChecks()

  log('\n— C：刷新确认不可播放后清缓存 —')
  await runCacheInvalidationCheck(target.id)

  log('\n— D：退出登录后不复用旧身份缓存 —')
  await runIdentityCacheCheck(target.id)

  log('\n— E：资料读取判定逻辑 —')
  runAssertionSelfTest()
  runExitCodeCheck()

  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
  }
  fs.writeFileSync(path.join(OUT, 'fixes-regression.json'), JSON.stringify(report, null, 2), 'utf-8')
  log(`\n结果：${report.summary.passed} 通过 / ${report.summary.failed} 失败`)
  log(`证据：${path.relative(ROOT, path.join(OUT, 'fixes-regression.json'))}`)
  if (report.summary.failed) process.exitCode = 1
}

main().catch((err) => {
  report.fatal = String(err.stack || err.message)
  if (fs.existsSync(SESSION_BACKUP) && !fs.existsSync(SESSION_FILE)) {
    fs.copyFileSync(SESSION_BACKUP, SESSION_FILE)
    fs.chmodSync(SESSION_FILE, 0o600)
    fs.unlinkSync(SESSION_BACKUP)
    log('已恢复会话文件')
  }
  fs.writeFileSync(path.join(OUT, 'fixes-regression.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.error('验证中止：', err.message)
  process.exitCode = 1
})
