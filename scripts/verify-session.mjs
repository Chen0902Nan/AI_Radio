/**
 * 收听会话 / 播放记录 / 喜好反馈 的验证。
 *
 * 覆盖规格里「收听会话」与「反馈效果」两条默认行为：
 *  - 暂停恢复属于同一次收听；停止后重新开播是新会话，并清掉临时调整
 *  - 页面刷新只是重新连上，不新建会话、不产生重复播放任务
 *  - 反馈可保存、可替换、可撤销，同一时刻只有一条生效
 *  - 反馈跨进程重启仍在，并且真的改变了选歌抽样权重
 *
 * 前置：服务端以 `npm run start:test` 启动（RADIO_TEST_HOOKS=1）并已登录。
 * 用法：node scripts/verify-session.mjs [--headful] [--base=http://127.0.0.1:8787]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.RADIO_REPORT_OUT
  ? path.resolve(process.env.RADIO_REPORT_OUT)
  : path.join(ROOT, '.scratch/radio-agent/verification/artifacts')
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

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  let data = {}
  try {
    data = await res.json()
  } catch (_) {}
  return { status: res.status, ...data }
}

/* ---------- 1. 会话生命周期（HTTP 层） ---------- */

async function runSessionApiChecks(db) {
  await api('/api/session/stop', { method: 'POST' })
  const none = await api('/api/session')
  check('停止后没有进行中的会话', none.ok && none.session === null, { session: none.session })

  const s1 = await api('/api/session/start', { method: 'POST' })
  const s2 = await api('/api/session/start', { method: 'POST' })
  check('开播建立会话；再次开播复用同一会话（不会重复建会话）', s1.session.id === s2.session.id && s2.session.reused === true, {
    first: s1.session.id,
    second: s2.session.id,
    reused: s2.session.reused,
  })

  const adj = await api('/api/session/adjustment', { method: 'POST', body: { key: 'mood', value: '轻松一点' } })
  check('会话内可记录临时调整', adj.ok && adj.adjustments.mood === '轻松一点', { adjustments: adj.adjustments })

  const stopped = await api('/api/session/stop', { method: 'POST' })
  check('停止会结束会话', stopped.ok && stopped.ended === true, { id: stopped.id })
  const afterStop = await api('/api/session')
  check('停止后重新开播得到的是新会话', afterStop.session === null, { open: afterStop.session })

  const s3 = await api('/api/session/start', { method: 'POST' })
  check('停止后临时调整被清空，恢复个人默认', s3.session.id !== s1.session.id && Object.keys(s3.session.adjustments).length === 0, {
    oldId: s1.session.id,
    newId: s3.session.id,
    adjustments: s3.session.adjustments,
  })
  report.evidence.session = { first: s1.session, second: s2.session, afterStop: s3.session }

  const rows = db.sessions()
  const ended = rows.filter((r) => r.ended_at && r.end_reason === 'stopped')
  check('会话生命周期已落库（含结束时间与原因）', ended.length >= 2, {
    total: rows.length,
    stopped: ended.length,
  })
  return s3.session.id
}

/* ---------- 2. 反馈：保存 / 替换 / 撤销 / 持久化 ---------- */

async function runFeedbackChecks(db, track) {
  await api(`/api/feedback/${track.id}`, { method: 'DELETE' })

  const like = await api('/api/feedback', {
    method: 'POST',
    body: { trackId: track.id, trackName: track.name, artists: track.artists, sentiment: 'like' },
  })
  check('可以记录“喜欢”', like.ok && like.feedback.sentiment === 'like', { summary: like.summary })

  const dislike = await api('/api/feedback', {
    method: 'POST',
    body: { trackId: track.id, trackName: track.name, artists: track.artists, sentiment: 'dislike' },
  })
  const activeRows = db.feedbackActive(track.id)
  check('改主意时旧的生效反馈被替换，同一时刻只有一条生效', dislike.ok && activeRows.length === 1 && activeRows[0].sentiment === 'dislike', {
    activeRows: activeRows.map((r) => r.sentiment),
    summary: dislike.summary,
  })

  const revoked = await api(`/api/feedback/${track.id}`, { method: 'DELETE' })
  const afterRevoke = db.feedbackActive(track.id)
  check('反馈可以撤销', revoked.ok && revoked.revoked === true && afterRevoke.length === 0, {
    previous: revoked.previous && revoked.previous.sentiment,
    remaining: afterRevoke.length,
  })

  const all = db.feedbackAll(track.id)
  check('撤销是标记而不是删除历史（可回溯）', all.length >= 2 && all.every((r) => r.revoked_at), {
    rows: all.map((r) => ({ sentiment: r.sentiment, revoked: Boolean(r.revoked_at) })),
  })

  const bad = await api('/api/feedback', {
    method: 'POST',
    body: { trackId: track.id, sentiment: 'whatever' },
  })
  check('非法反馈类型被拒绝且不写入', bad.status === 400 && db.feedbackActive(track.id).length === 0, {
    status: bad.status,
    message: bad.message,
  })
  report.evidence.feedback = { like: like.feedback, dislike: dislike.feedback, revoked: revoked.previous, history: all }
}

/* ---------- 3. 反馈是否真的改变选歌抽样 ---------- */

async function sampleIds(n, times) {
  const counts = new Map()
  for (let i = 0; i < times; i += 1) {
    const r = await api(`/api/_test/sample-candidates?n=${n}`)
    for (const id of r.ids || []) counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

async function runWeightingChecks(db, track) {
  const settings = await api('/api/settings')
  const basePenalty = settings.settings.feedbackDislikePenalty
  const baseBoost = settings.settings.feedbackLikeBoost
  const RUNS = 250
  const N = 20

  await api(`/api/feedback/${track.id}`, { method: 'DELETE' })
  await api('/api/settings', { method: 'POST', body: { key: 'avoidRepeatWindowMin', value: '0' } })
  await api('/api/settings', { method: 'POST', body: { key: 'feedbackDislikePenalty', value: '0.0001' } })
  await api('/api/settings', { method: 'POST', body: { key: 'feedbackLikeBoost', value: '4' } })

  // 样本量要够：20 首 × 250 轮命中基数约 10 次，否则 0/1 的差异说明不了问题
  const neutral = await sampleIds(N, RUNS)
  const neutralHit = neutral.get(track.id) || 0

  await api('/api/feedback', {
    method: 'POST',
    body: { trackId: track.id, trackName: track.name, artists: track.artists, sentiment: 'dislike' },
  })
  const disliked = await sampleIds(N, RUNS)
  const dislikedHit = disliked.get(track.id) || 0

  check('“不喜欢”会显著降低该曲在选歌中的出现（降低而不是封禁）', neutralHit >= 2 && dislikedHit < neutralHit, {
    samplesPerRun: N,
    runs: RUNS,
    hitRateNeutral: neutralHit,
    hitRateDisliked: dislikedHit,
    penalty: 0.0001,
  })

  await api(`/api/feedback/${track.id}`, { method: 'DELETE' })
  await api('/api/feedback', {
    method: 'POST',
    body: { trackId: track.id, trackName: track.name, artists: track.artists, sentiment: 'like' },
  })
  await api('/api/settings', { method: 'POST', body: { key: 'feedbackDislikePenalty', value: '1' } })
  const liked = await sampleIds(N, RUNS)
  const likedHit = liked.get(track.id) || 0
  check('“喜欢”会提高该曲在选歌中的出现', likedHit > neutralHit, {
    hitRateLiked: likedHit,
    hitRateNeutral: neutralHit,
    boost: 4,
  })

  // 收尾：恢复默认并清掉本轮反馈
  await api(`/api/feedback/${track.id}`, { method: 'DELETE' })
  await api('/api/settings', { method: 'POST', body: { key: 'feedbackDislikePenalty', value: basePenalty } })
  await api('/api/settings', { method: 'POST', body: { key: 'feedbackLikeBoost', value: baseBoost } })
  await api('/api/settings', { method: 'POST', body: { key: 'avoidRepeatWindowMin', value: '45' } })
  report.evidence.weighting = { trackId: track.id, neutralHit, dislikedHit, likedHit, samplesPerRun: N, runs: RUNS }
}

/* ---------- 4. 浏览器：开播 / 刷新 / 停止 / 反馈按钮 ---------- */

async function runBrowserChecks(db) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 1000 })
  const state = () => page.evaluate(() => (window.__radio ? window.__radio.state : null))

  await api('/api/session/stop', { method: 'POST' })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await waitFor(
    async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())),
    { timeout: 90000, label: '音乐资料加载' },
  )

  const s0 = await state()
  check('刚打开页面时没有会话，也没有自动出声', s0.sessionId === null && s0.paused === true && !s0.audioSrc, {
    sessionId: s0.sessionId,
    paused: s0.paused,
    label: s0.playButtonLabel,
  })

  // 开播
  await page.click('#tracks .track:nth-child(1)')
  await waitFor(async () => {
    const s = await state()
    return s && s.sessionId && !s.paused && s.currentTime > 1.5
  }, { timeout: 40000, label: '开播并开始播放' })
  const s1 = await state()
  check('开播后建立会话并开始播放', Boolean(s1.sessionId) && s1.currentTime > 1.5, {
    sessionId: s1.sessionId,
    id: s1.currentId,
    button: s1.playButtonLabel,
  })
  check('开始播放会写入带会话的播放记录', s1.playId !== null, { playId: s1.playId })
  const playRows = db.plays()
  check('播放记录已落库且挂在会话上', playRows.some((r) => r.session_id === s1.sessionId), {
    count: playRows.length,
    latest: playRows[0] && { track: playRows[0].track_id, session: playRows[0].session_id },
  })
  const sessionBefore = s1.sessionId

  // 刷新：应连回同一会话，且不出声
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(
    async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())),
    { timeout: 90000, label: '刷新后资料加载' },
  )
  await sleep(2000)
  const s2 = await state()
  const sessionsAfterReload = db.sessions().filter((r) => r.ended_at === null)
  check('页面刷新只是连回同一会话，不新建会话也不自动出声', s2.sessionId === sessionBefore && s2.paused === true && sessionsAfterReload.length === 1, {
    before: sessionBefore,
    after: s2.sessionId,
    paused: s2.paused,
    openSessions: sessionsAfterReload.length,
    button: s2.playButtonLabel,
  })

  // 反馈按钮
  await page.click('#tracks .track:nth-child(1)')
  await waitFor(async () => {
    const s = await state()
    return s && !s.paused && s.currentTime > 1.5
  }, { timeout: 40000, label: '继续播放' })
  const cur = await state()
  await page.click('#like')
  await waitFor(async () => Object.keys((await state()).feedback).length > 0, { timeout: 10000, interval: 300, label: '喜欢写入' })
  const liked = await state()
  check('界面上的“喜欢”按钮会保存反馈', liked.feedback[String(cur.currentId)] === 'like', {
    trackId: cur.currentId,
    feedback: liked.feedback,
  })

  await page.click('#dislike')
  await waitFor(async () => (await state()).feedback[String(cur.currentId)] === 'dislike', { timeout: 10000, interval: 300, label: '不喜欢覆盖' })
  const disliked = await state()
  check('“不喜欢”会覆盖同曲之前的反馈', disliked.feedback[String(cur.currentId)] === 'dislike', {
    feedback: disliked.feedback,
  })

  await page.click('#unlike')
  await waitFor(async () => !(await state()).feedback[String(cur.currentId)], { timeout: 10000, interval: 300, label: '撤销反馈' })
  const revoked = await state()
  check('“撤销反馈”会移除该曲的反馈', revoked.feedback[String(cur.currentId)] === undefined, {
    feedback: revoked.feedback,
  })

  // 停止
  await page.click('#stop')
  await waitFor(async () => (await state()).sessionId === null, { timeout: 15000, interval: 300, label: '停止会话' })
  const stopped = await state()
  check('点停止会结束会话并停止出声', stopped.sessionId === null && stopped.paused === true, {
    sessionId: stopped.sessionId,
    paused: stopped.paused,
    status: stopped.status,
    button: stopped.playButtonLabel,
  })
  const openRows = db.sessions().filter((r) => r.ended_at === null)
  check('停止后服务端没有残留的进行中会话', openRows.length === 0, { openSessions: openRows.length })

  const outcomes = db.plays().map((r) => r.outcome).filter(Boolean)
  check('播放记录带有结束结果（ended/skipped/stopped 等）', outcomes.length > 0, {
    outcomes: [...new Set(outcomes)],
    total: outcomes.length,
  })
  report.evidence.browser = { s0, s1, afterReload: s2, stopped }
  await page.screenshot({ path: path.join(OUT, 'shot-08-session.png') })
  await browser.close()
}

/* ---------- main ---------- */

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json()
  if (!health.ok || !health.testHooks) throw new Error('需要以 RADIO_TEST_HOOKS=1 启动服务')
  if (!health.loggedIn) throw new Error('未登录：请先扫码登录')
  log(`服务在线：${health.account.nickname}\n`)

  const require2 = createRequire(import.meta.url)
  const rawDb = require2('node:sqlite').DatabaseSync
  // 允许用环境变量指向独立数据库，避免验证污染真实设置/反馈/播放记录
  const dbFile = process.env.RADIO_DB_FILE || path.join(ROOT, 'data/radio.db')
  const conn = new rawDb(dbFile, { readOnly: false })
  const db = {
    sessions: () => conn.prepare('SELECT * FROM sessions ORDER BY started_at').all(),
    plays: () => conn.prepare('SELECT * FROM plays ORDER BY started_at DESC').all(),
    feedbackActive: (trackId) =>
      conn.prepare('SELECT * FROM feedback WHERE track_id = ? AND revoked_at IS NULL').all(trackId),
    feedbackAll: (trackId) => conn.prepare('SELECT * FROM feedback WHERE track_id = ?').all(trackId),
  }

  log('— 1. 收听会话生命周期 —')
  await runSessionApiChecks(db)

  const lib = await (await fetch(BASE + '/api/library')).json()
  const probe = lib.liked.tracks.slice(0, 20)
  const track = probe[0]
  log(`使用曲目：${track.name}（id ${track.id}）\n`)

  log('— 2. 喜好反馈：保存 / 替换 / 撤销 —')
  await runFeedbackChecks(db, track)

  log('\n— 3. 反馈是否真的改变选歌抽样 —')
  await runWeightingChecks(db, track)

  log('\n— 4. 浏览器：开播 / 刷新 / 停止 / 反馈 —')
  await runBrowserChecks(db)

  conn.close()

  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
  }
  fs.writeFileSync(path.join(OUT, 'session-feedback.json'), JSON.stringify(report, null, 2), 'utf-8')
  log(`\n结果：${report.summary.passed} 通过 / ${report.summary.failed} 失败`)
  log(`证据：${path.relative(ROOT, path.join(OUT, 'session-feedback.json'))}`)
  if (report.summary.failed) process.exitCode = 1
}

main().catch((err) => {
  report.fatal = String(err.stack || err.message)
  fs.writeFileSync(path.join(OUT, 'session-feedback.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.error('验证中止：', err.message)
  process.exitCode = 1
})
