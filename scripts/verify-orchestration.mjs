/**
 * 自动补歌与统一节目编排的验证。
 *
 * 覆盖本次范围里可观察的行为：
 *  1. 编排控制器单元行为：阈值触发、在途去重、指数退避、上限后等待恢复、取消作废迟到结果
 *  2. 服务端补歌协调：同会话同意图不并发重复生成、新意图作废旧任务、停止会话作废结果、
 *     Codex 失败降级用曲库候选并进入冷却、排除当前/已排队、候选耗尽、无可播、音乐服务不可用
 *  3. 真实浏览器：跨批续播不断、补歌不打断当前歌曲、暂停期间迟到结果不出声、停止后旧结果不污染、
 *     刷新不新建会话/不自动出声、快速切歌不被补歌覆盖、Codex 失败时降级续播
 *  4. 一次真实 Codex 补歌（可 --skip-real 跳过）
 *
 * 隔离：脚本自己拉起一个独立服务进程，使用临时 SQLite 文件与独立端口，
 * 不写真实反馈/设置/播放记录；只读共享 data/session.json 完成登录态。
 *
 * 用法：node scripts/verify-orchestration.mjs [--skip-real] [--headful] [--base=http://127.0.0.1:8792]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
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

const { RefillController } = require('../public/orchestrator.js')

const args = process.argv.slice(2)
const EXTERNAL_BASE = (args.find((a) => a.startsWith('--base=')) || '').split('=')[1]
const HEADLESS = !args.includes('--headful')
const SKIP_REAL = args.includes('--skip-real')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.RADIO_TEST_PORT || 8792)
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`

const report = { at: new Date().toISOString(), base: BASE, isolated: !EXTERNAL_BASE, checks: [], evidence: {} }
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), detail })
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}

async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
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

const post = (p, body) => api(p, { method: 'POST', body: body || {} })

/* ================= 阶段 0：独立服务进程 ================= */

let child = null
let tmpDir = null
let dbPath = null
let reportBrowser = null

async function startIsolatedServer() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-orch-'))
  dbPath = path.join(tmpDir, 'radio.db')
  const logFile = path.join(tmpDir, 'server.log')
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      RADIO_TEST_HOOKS: '1',
      RADIO_DB_FILE: dbPath,
    },
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
  })
  await waitFor(
    async () => {
      try {
        const h = await api('/api/health')
        return h.ok
      } catch (_) {
        return false
      }
    },
    { timeout: 30000, interval: 500, label: '独立服务启动' },
  )
  report.evidence.isolatedServer = { port: PORT, db: path.basename(dbPath), log: logFile }
}

function stopIsolatedServer() {
  if (child && !child.killed) child.kill('SIGTERM')
}

function openDb() {
  const rawDb = require('node:sqlite').DatabaseSync
  return new rawDb(dbPath, { readOnly: true })
}

/* ================= 阶段 1：编排控制器单元测试 ================= */

function makeClock(start = 0) {
  let now = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, at: now + Math.max(0, ms) })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    advance: (ms) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)
        if (!due.length) break
        const [id, t] = due[0]
        timers.delete(id)
        now = t.at
        t.fn()
      }
      now = target
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

async function runControllerUnitChecks() {
  const clock = makeClock()
  const calls = []
  const batches = []
  const statuses = []
  let responder = () => Promise.resolve({ ok: true, picks: [{ id: 101, type: 'track' }] })

  const c = new RefillController({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    config: { threshold: 1, batchSize: 2, backoffBaseMs: 1000, backoffMaxMs: 4000, maxAttempts: 3 },
    getContext: () => ({ sessionId: 's1', playing: true, stopped: false, pending: 0, brief: '' }),
    getExclusion: () => [9],
    requestBatch: (req) => {
      calls.push(req)
      return responder(req)
    },
    onBatch: (picks) => {
      batches.push(picks)
      return picks.length
    },
    onStatus: (text, cls) => statuses.push({ text, cls }),
  })

  // 阈值与在途去重
  c.check()
  const during = c.check()
  await flush()
  check('控制器：待播不足且正在收听时触发一次补歌', calls.length === 1 && batches.length === 1, {
    calls: calls.length,
    batches: batches.length,
    exclusion: calls[0] && calls[0].excludeIds,
  })
  check('控制器：在途期间重复触发不会重复生成', during === false && calls.length === 1, { secondCheck: during })
  check('控制器：结果通过 onBatch 只交给追加逻辑（不替换队列）', batches[0][0].id === 101)

  // 阈值之上不触发
  c.getContext = () => ({ sessionId: 's1', playing: true, stopped: false, pending: 3 })
  check('控制器：待播充足时不触发补歌', c.check() === false, { pending: 3, threshold: c.config.threshold })

  // 指数退避 + 上限
  c.getContext = () => ({ sessionId: 's1', playing: true, stopped: false, pending: 0 })
  responder = () => Promise.resolve({ ok: false, code: 'quota', message: '额度受限' })
  c.check()
  await flush()
  const s1 = c.snapshot()
  check('控制器：失败后进入退避（不是紧密重试）', s1.state === 'backoff' && s1.attempts === 1 && s1.nextRetryAt - clock.now() === 1000, {
    state: s1.state,
    attempts: s1.attempts,
    delayMs: s1.nextRetryAt - clock.now(),
  })
  clock.advance(1000)
  await flush()
  const s2 = c.snapshot()
  clock.advance(2000)
  await flush()
  const s3 = c.snapshot()
  check('控制器：退避按 1s→2s 递增，达到最大次数后等待恢复', s2.attempts === 2 && s3.state === 'waiting_recovery' && s3.attempts === 3, {
    afterSecond: { attempts: s2.attempts, delayMs: s2.nextRetryAt - (clock.now() - 1000) },
    afterThird: { state: s3.state, attempts: s3.attempts },
  })
  const callsAtRecovery = calls.length
  clock.advance(60 * 60 * 1000)
  await flush()
  check('控制器：等待恢复后不再自动重试（不用无限重试掩盖问题）', calls.length === callsAtRecovery && c.snapshot().state === 'waiting_recovery', {
    callsBefore: callsAtRecovery,
    callsAfterAnHour: calls.length,
  })
  c.resume()
  responder = () => Promise.resolve({ ok: true, picks: [{ id: 202, type: 'track' }] })
  c.check()
  await flush()
  check('控制器：用户动作可以从等待恢复中重新拉起补歌', calls.length === callsAtRecovery + 1 && batches.length === 2, {
    calls: calls.length,
    batches: batches.length,
  })

  // 取消作废迟到结果
  let release
  responder = () => new Promise((r) => (release = r))
  c.check()
  await flush() // 让 requestBatch 真正被调用，拿到 release
  const epochBefore = c.snapshot().epoch
  c.cancel('stopped', { reset: true })
  release({ ok: true, picks: [{ id: 303, type: 'track' }] })
  await flush()
  check('控制器：取消后迟到的补歌结果不会落到队列上', batches[batches.length - 1][0].id === 202 && c.snapshot().epoch === epochBefore + 1, {
    lastBatch: batches[batches.length - 1][0].id,
    epochBefore,
    epochAfter: c.snapshot().epoch,
  })

  // 新意图作废旧结果
  responder = () => Promise.resolve({ ok: false, code: 'superseded', message: '被新意图取代' })
  const attemptsBefore = c.snapshot().attempts
  c.check()
  await flush()
  check('控制器：被新意图取代的结果按“作废”处理，不计为失败重试', c.snapshot().state === 'idle' && c.snapshot().attempts === attemptsBefore, {
    state: c.snapshot().state,
    attempts: c.snapshot().attempts,
  })

  // 会话失效但客户端已换新会话：不能停在旧结果上，应再试一次
  let ctxSession = { sessionId: 'old', playing: true, stopped: false, pending: 0 }
  c.getContext = () => ctxSession
  let seq2 = 0
  batches.length = 0
  responder = () => {
    seq2 += 1
    if (seq2 === 1) return Promise.resolve({ ok: false, code: 'session_ended', message: '会话已结束' })
    return Promise.resolve({ ok: true, picks: [{ id: 404, type: 'track' }] })
  }
  c.check()
  ctxSession = { sessionId: 'new', playing: true, stopped: false, pending: 0 }
  await flush()
  await flush()
  check('控制器：服务端会话失效但客户端已换新会话时，会再试一次而不是停住', batches.length === 1 && batches[0][0].id === 404 && seq2 === 2, {
    calls: seq2,
    batches: batches.length,
  })

  // 本地取消后，尚未发出的请求不应该真的发往服务端
  let lateCalls = 0
  c.getContext = () => ({ sessionId: 's2', playing: true, stopped: false, pending: 0 })
  responder = () => {
    lateCalls += 1
    return Promise.resolve({ ok: true, picks: [{ id: 505, type: 'track' }] })
  }
  c.check()
  c.cancel('stopped', { reset: true }) // 在请求发出前就取消
  await flush()
  check('控制器：本地取消后，过期的补歌请求不会发往服务端', lateCalls === 0, { calls: lateCalls })

  // 结果与待播全部重复（实际追加 0 首）：按失败处理，走退避
  batches.length = 0
  responder = () => Promise.resolve({ ok: true, picks: [{ id: 606, type: 'track' }, { id: 607, type: 'track' }] })
  c.onBatch = () => 0 // 模拟前端把返回结果全部过滤掉
  const attemptsBeforeDup = c.snapshot().attempts
  c.check()
  await flush()
  const dupState = c.snapshot()
  check('控制器：实际追加 0 首时按失败处理（退避重试，不假装补充成功）', dupState.attempts === attemptsBeforeDup + 1 && dupState.state === 'backoff' && batches.length === 0, {
    attempts: dupState.attempts,
    state: dupState.state,
    batches: batches.length,
  })
  c.onBatch = (picks) => {
    batches.push(picks)
    return picks.length
  }

  report.evidence.controllerUnit = { calls: calls.length, statuses }
}

/* ================= 阶段 2：服务端补歌协调 ================= */

async function runServerChecks() {
  await post('/api/session/stop')
  const s = (await post('/api/session/start')).session

  // 同会话同意图：并发请求只生成一批
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 1200 })
  await post('/api/_test/codex-stats?reset=1')
  const [a, b] = await Promise.all([
    post('/api/queue/refill', { sessionId: s.id, epoch: 10, excludeIds: [], count: 4 }),
    post('/api/queue/refill', { sessionId: s.id, epoch: 10, excludeIds: [], count: 4 }),
  ])
  const statsAfterDedup = (await api('/api/_test/codex-stats')).stats
  const sameBatch = JSON.stringify((a.picks || []).map((p) => p.id)) === JSON.stringify((b.picks || []).map((p) => p.id))
  check('服务端：同一会话同一意图的并发补歌只生成一批（另一个复用结果）', a.ok && b.ok && sameBatch && statsAfterDedup.calls === 1, {
    deduped: [a.deduped, b.deduped],
    codexCalls: statsAfterDedup.calls,
    sameBatch,
  })

  // 新意图作废旧任务
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 1200 })
  const p1 = post('/api/queue/refill', { sessionId: s.id, epoch: 20, excludeIds: [], count: 4 })
  await sleep(300)
  const p2 = post('/api/queue/refill', { sessionId: s.id, epoch: 21, excludeIds: [], count: 4 })
  const r1 = await p1
  const r2 = await p2
  check('服务端：更新的编排意图会让旧补歌任务作废', r1.code === 'superseded' && r2.ok && (r2.picks || []).length > 0, {
    old: { status: r1.status, code: r1.code },
    next: { status: r2.status, picks: (r2.picks || []).length },
  })
  await post('/api/_test/codex-mode', { mode: 'success' })

  // 乱序：迟到的旧请求不能取消更新的在途任务，也不能重复调 Codex
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 1200 })
  await post('/api/_test/codex-stats?reset=1')
  const newerFlight = post('/api/queue/refill', { sessionId: s.id, epoch: 200, excludeIds: [], count: 3 })
  await sleep(300)
  const staleReq = await post('/api/queue/refill', { sessionId: s.id, epoch: 100, excludeIds: [], count: 3 })
  const newerResult = await newerFlight
  const statsOrder = (await api('/api/_test/codex-stats')).stats
  check('服务端：迟到的过期请求被拒绝，不取消更新的在途任务、也不重复调用', staleReq.ok === false && staleReq.code === 'superseded' && newerResult.ok === true && statsOrder.calls === 1, {
    stale: { code: staleReq.code },
    newer: { ok: newerResult.ok, picks: (newerResult.picks || []).length },
    codexCalls: statsOrder.calls,
  })
  await post('/api/_test/codex-mode', { mode: 'success' })

  // 排除当前与已排队；结果不重复
  const lib = await api('/api/library')
  const libIds = lib.liked.tracks.map((t) => t.id)
  const excludedFirst = libIds.slice(0, 12)
  const excl = await post('/api/queue/refill', { sessionId: s.id, epoch: 22, excludeIds: excludedFirst, count: 5 })
  const exclIds = (excl.picks || []).map((p) => p.id)
  check('服务端：候选会排除当前曲与已排队曲，且结果不重复', excl.ok && exclIds.every((id) => !excludedFirst.includes(id)) && new Set(exclIds).size === exclIds.length, {
    excluded: excludedFirst.length,
    picks: exclIds,
  })
  check('服务端：进队列前每首都有可播性校验', (excl.picks || []).every((p) => p.playable === true && p.type === 'track'), {
    kinds: (excl.picks || []).map((p) => p.kind),
  })

  // Codex 失败 → 降级曲库候选；冷却期内不再调用
  await post('/api/session/stop')
  const s2 = (await post('/api/session/start')).session
  await post('/api/_test/codex-mode', { mode: 'timeout' })
  await post('/api/_test/codex-stats?reset=1')
  const d1 = await post('/api/queue/refill', { sessionId: s2.id, epoch: 30, excludeIds: [], count: 3 })
  const d2 = await post('/api/queue/refill', { sessionId: s2.id, epoch: 31, excludeIds: [], count: 3 })
  const statsCooldown = (await api('/api/_test/codex-stats')).stats
  check('服务端：Codex 超时时用曲库候选降级续播', d1.ok && d1.degraded === true && d1.source === 'library' && (d1.picks || []).length > 0 && (d1.picks || []).every((p) => p.playable), {
    reason: d1.reason,
    picks: (d1.picks || []).map((p) => p.id),
  })
  check('服务端：失败后进入冷却，冷却期内不再消耗 Codex 调用', d2.ok && d2.degraded === true && d2.reason === 'codex_cooldown' && statsCooldown.calls === 1, {
    secondReason: d2.reason,
    codexCalls: statsCooldown.calls,
  })
  await post('/api/_test/codex-mode', { mode: 'success' })

  // 候选耗尽
  const exhausted = await post('/api/queue/refill', { sessionId: s2.id, epoch: 32, excludeIds: libIds, count: 3 })
  check('服务端：候选被排除完时报“候选不足”，不伪造结果', exhausted.code === 'candidates_exhausted' && exhausted.status === 409, {
    status: exhausted.status,
    code: exhausted.code,
    message: exhausted.message,
  })

  // 全部不可播 → no_playable
  await post('/api/_test/codex-mode', { mode: 'success' })
  await post('/api/_test/clear-url-cache')
  await post('/api/_test/unplayable-next', { count: 2000 })
  const np = await post('/api/queue/refill', { sessionId: s2.id, epoch: 33, excludeIds: [], count: 3 })
  check('服务端：所有候选都不可播时明确报 no_playable', np.ok !== true && np.code === 'no_playable', { status: np.status, code: np.code })

  // 音乐接口整体报错 → music_unavailable
  await post('/api/_test/clear-url-cache')
  await post('/api/_test/resolve-error-next', { count: 2000 })
  const mu = await post('/api/queue/refill', { sessionId: s2.id, epoch: 34, excludeIds: [], count: 3 })
  check('服务端：音乐接口整体不可用时明确报 music_unavailable', mu.ok !== true && mu.code === 'music_unavailable' && mu.status === 503, {
    status: mu.status,
    code: mu.code,
    message: mu.message,
  })

  // 停止会话作废在途结果
  await post('/api/session/stop')
  const s3 = (await post('/api/session/start')).session
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 1500 })
  const p3 = post('/api/queue/refill', { sessionId: s3.id, epoch: 40, excludeIds: [], count: 3 })
  await sleep(300)
  const stopped = await post('/api/session/stop')
  const late = await p3
  const openAfterStop = (await api('/api/session')).session
  check('服务端：停止会话会作废在途补歌，结果不会落库/外泄', ['superseded', 'session_ended'].includes(late.code) && stopped.ended === true && openAfterStop === null, {
    lateCode: late.code,
    stopped: stopped.ended,
    openSession: openAfterStop,
  })
  await post('/api/_test/codex-mode', { mode: 'success' })
  // 清掉故障注入，避免污染后面的真实调用与浏览器验证
  await post('/api/_test/unplayable-next', { count: 0 })
  await post('/api/_test/resolve-error-next', { count: 0 })
  report.evidence.server = { dedup: statsAfterDedup, degraded: d1.reason, secondReason: d2.reason, exhausted: exhausted.message }
}

/* ================= 阶段 3：真实 Codex 补歌（一次） ================= */

async function runRealCodexRefill() {
  if (SKIP_REAL) {
    report.skipped = (report.skipped || []).concat([{ name: '真实 Codex 补歌' }])
    log('  SKIP  真实 Codex 补歌（--skip-real）')
    return
  }
  await post('/api/session/stop')
  const s = (await post('/api/session/start')).session
  await post('/api/_test/codex-mode', { mode: 'off' })
  const t0 = Date.now()
  const r = await post('/api/queue/refill', { sessionId: s.id, epoch: 50, excludeIds: [], count: 3, brief: '傍晚放松，适合一个人安静地听' })
  check('真实 Codex 补歌返回可播批次，并带真实 token 统计', r.ok === true && r.source === 'codex' && (r.picks || []).length > 0 && (r.picks || []).every((p) => p.playable), {
    wallMs: Date.now() - t0,
    picks: (r.picks || []).map((p) => ({ id: p.id, name: p.name, reason: p.reason })),
    meta: r.meta && r.meta.codex ? { durationMs: r.meta.codex.durationMs, tokens: r.meta.codex.tokens, exitCode: r.meta.codex.exitCode } : null,
  })
  report.evidence.realCodex = { picks: r.picks, meta: r.meta }
  await post('/api/session/stop')
}

/* ================= 阶段 4：真实浏览器 ================= */

async function pickPlayableTracks(n) {
  const lib = await api('/api/library')
  const out = []
  for (const t of lib.liked.tracks.slice(0, 30)) {
    const r = await api(`/api/resolve/${t.id}`)
    if (r.playable) out.push({ id: t.id, name: t.name, artists: t.artists, album: t.album, durationMs: t.durationMs, type: 'track' })
    if (out.length >= n) break
  }
  return out
}

async function setSettings(pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    await post('/api/settings', { key, value })
  }
}

async function runBrowserChecks(tracks) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'],
  })
  reportBrowser = browser
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 1000 })
  const state = () => page.evaluate(() => (window.__radio ? window.__radio.state : null))
  const replaceQueue = (ids) =>
    page.evaluate((ts) => window.__radio.__test.replaceQueue(ts), ids.map((id) => tracks.find((t) => t.id === id)))
  const seekEnd = async () => {
    // 刚切歌时 duration 可能还没就绪，先等到音频元数据可用再拖到结尾
    await waitFor(
      () =>
        page.evaluate(() => {
          const a = document.querySelector('audio')
          return Boolean(a && Number.isFinite(a.duration) && a.duration > 0 && a.readyState >= 2 && !a.paused)
        }),
      { timeout: 20000, interval: 200, label: '音频就绪' },
    )
    return page.evaluate(() => window.__radio.__test.seekToEnd())
  }

  const loadPage = async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await waitFor(async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())), {
      timeout: 90000,
      label: '音乐资料加载',
    })
  }
  const startPlaying = async (ids) => {
    await post('/api/session/stop')
    await replaceQueue(ids)
    await page.click('#play')
    await waitFor(
      async () => {
        const s = await state()
        return s && s.sessionId && !s.paused && s.currentTime > 0.8
      },
      { timeout: 40000, label: '开始播放' },
    )
    return state()
  }

  await loadPage()

  // 让客户端配置与设置一致（验证设置真的驱动补歌参数）
  await setSettings({ refillThreshold: '1', refillBatchSize: '3', refillBackoffBaseMs: '1000', refillMaxAttempts: '3' })
  await loadPage()
  const cfg = await page.evaluate(() => window.__radio.__test.config())
  check('网页：补歌参数来自本地设置（阈值/批量/退避）', cfg.threshold === 1 && cfg.batchSize === 3 && cfg.backoffBaseMs === 1000, cfg)

  const t1 = tracks[0]
  const t2 = tracks[1]

  /* ---- 3.1 跨批续播：第一首自然播完，直接接上后台补充的一批 ---- */
  await post('/api/_test/codex-mode', { mode: 'success' })
  // 用曲库中最短的一首做自然播完，控制验证时长
  const natural = tracks.slice().sort((a, b) => a.durationMs - b.durationMs)[0]
  await setSettings({ refillThreshold: '1', refillBatchSize: '3' })
  await page.evaluate(() => window.__radio.__test.setConfig({ threshold: 1, batchSize: 3 }))
  await startPlaying([natural.id])
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 30000, label: '后台补充第一批' })
  const afterRefill = await state()
  check('网页：后台补歌只追加，不打断正在播放的歌', afterRefill.currentId === natural.id && afterRefill.paused === false && afterRefill.autoQueueIds.length > 0, {
    currentId: afterRefill.currentId,
    queueLength: afterRefill.queueLength,
    autoQueueIds: afterRefill.autoQueueIds,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-09-crossbatch-prep.png') })

  // 不拖进度：等这首自然播完触发真实的 ended，跨批边界由此产生
  await waitFor(
    async () => {
      const s = await state()
      return s.autoQueueIds.includes(s.currentId) && !s.paused
    },
    { timeout: (natural.durationMs / 1000 + 90) * 1000, interval: 1000, label: '第一首自然播完并接入补歌批次' },
  )
  const cross = await state()
  check('网页：第一首自然播完后自动接入后台补充的一批（没有因队列耗尽停止）', cross.autoQueueIds.includes(cross.currentId) && cross.paused === false && cross.stopped === false, {
    currentId: cross.currentId,
    naturalTrack: { id: natural.id, durationSec: +(natural.durationMs / 1000).toFixed(1) },
    fromBatch: cross.autoQueueIds,
    status: cross.status,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-10-crossbatch-playing.png') })

  /* ---- 3.1b 队列播完时等待后台批次，而不是停止 ---- */
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4000 })
  await startPlaying([natural.id])
  await seekEnd() // 立刻把这首播完：此刻补歌还在路上
  await waitFor(async () => (await state()).awaitingRefill === true, { timeout: 15000, interval: 200, label: '进入等待补歌状态' })
  const waiting = await state()
  await waitFor(
    async () => {
      const s = await state()
      return s.autoQueueIds.includes(s.currentId) && !s.paused
    },
    { timeout: 20000, label: '批次到达后继续播放' },
  )
  const resumed = await state()
  check('网页：队列播完时进入等待，批次到达后自动继续（不停止播放）', waiting.awaitingRefill === true && resumed.autoQueueIds.includes(resumed.currentId) && resumed.paused === false && resumed.stopped === false, {
    waitingStatus: waiting.status,
    resumedId: resumed.currentId,
    fromBatch: resumed.autoQueueIds,
  })

  /* ---- 3.1c 已播过的歌可以再次被补入：完整队列播到底不停止 ---- */
  await post('/api/_test/codex-mode', { mode: 'success' })
  // 强制服务端返回第 1 首（此时它已是历史曲目）：验证不按整个历史队列去重
  await post('/api/_test/refill-forced-picks', { ids: [tracks[0].id], count: 1 })
  await page.evaluate(() => window.__radio.__test.setConfig({ threshold: 1, batchSize: 2 }))
  await startPlaying([tracks[0].id, tracks[1].id, tracks[2].id])
  // 切到第 2 首：第 1 首成为历史，待播只剩 1 首，触发补歌；强制服务端返回那首已播过的歌
  await page.click('#next')
  await waitFor(
    async () => {
      const s = await state()
      return s.currentId === tracks[1].id && !s.paused && s.queueLength === 4
    },
    { timeout: 30000, label: '已播曲目被重新补入队列' },
  )
  const historyBack = await state()
  check('网页：补歌返回已播过的歌曲时仍会追加（不按整个历史队列去重清零）', historyBack.queueLength === 4 && historyBack.autoQueueIds.includes(tracks[0].id) && historyBack.currentId === tracks[1].id, {
    queueLength: historyBack.queueLength,
    reAppended: historyBack.autoQueueIds,
    currentId: historyBack.currentId,
    prepStatus: historyBack.prepStatus,
  })
  // 把剩余待播播完，越过原队尾，继续播放重新补入的那首
  await seekEnd()
  await waitFor(async () => (await state()).currentId === tracks[2].id, { timeout: 20000, label: '切到第三首' })
  await seekEnd()
  await waitFor(
    async () => {
      const s = await state()
      return s.currentId === tracks[0].id && !s.paused
    },
    { timeout: 20000, label: '越过原队尾继续播放' },
  )
  const tail = await state()
  check('网页：完整队列播到底后继续播放（不因队列耗尽停止）', tail.currentId === tracks[0].id && tail.paused === false && tail.stopped === false, {
    currentId: tail.currentId,
    queueLength: tail.queueLength,
    status: tail.status,
  })
  await post('/api/_test/refill-forced-picks', { ids: [] })

  /* ---- 3.2 Codex 慢响应不阻塞已有音乐 ---- */
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4500 })
  await setSettings({ refillThreshold: '5', refillBatchSize: '3' })
  await page.evaluate(() => window.__radio.__test.setConfig({ threshold: 5, batchSize: 3 }))
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途' })
  const slowA = await state()
  await sleep(2500)
  const slowB = await state()
  check('网页：Codex 生成较慢时，已有歌曲继续播放、没有被阻塞', slowA.currentId === slowB.currentId && slowB.paused === false && slowB.currentTime > slowA.currentTime, {
    currentId: slowB.currentId,
    advancedBy: +(slowB.currentTime - slowA.currentTime).toFixed(2),
    inFlightDuring: slowB.refill.inFlight,
  })
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 20000, label: '慢响应批次到达' })
  const slowC = await state()
  check('网页：慢响应批次到达后只追加，当前歌曲仍是同一首', slowC.currentId === t1.id && slowC.paused === false && slowC.autoQueueIds.length > 0, {
    currentId: slowC.currentId,
    autoQueueIds: slowC.autoQueueIds,
  })

  /* ---- 3.3 暂停期间的迟到结果不出声 ---- */
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 4000 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（暂停用例）' })
  await page.click('#play') // 暂停
  await waitFor(async () => (await state()).paused === true, { timeout: 10000, label: '暂停生效' })
  const pausedAt = await state()
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 20000, label: '暂停期间批次到达' })
  await sleep(1200)
  const afterLate = await state()
  check('网页：暂停期间到达的补歌结果只追加，不会自动出声', afterLate.paused === true && Math.abs(afterLate.currentTime - pausedAt.currentTime) < 1.2 && afterLate.autoQueueIds.length > 0, {
    paused: afterLate.paused,
    timeDelta: +(afterLate.currentTime - pausedAt.currentTime).toFixed(2),
    autoQueueIds: afterLate.autoQueueIds,
    prepStatus: afterLate.prepStatus,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-11-paused-late-result.png') })
  await page.click('#play') // 恢复，确认仍可继续
  await waitFor(async () => (await state()).paused === false, { timeout: 15000, label: '暂停后恢复播放' })

  /* ---- 3.4 停止后旧补歌结果不污染下一次会话 ---- */
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 3500 })
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（停止用例）' })
  await page.click('#stop')
  await waitFor(async () => (await state()).sessionId === null, { timeout: 15000, label: '停止生效' })
  await sleep(4200) // 等旧批次在服务端完成
  const afterStop = await state()
  const orch = await api('/api/_test/orchestrator-state')
  check('网页：停止后旧补歌结果不会追加到队列，也不会污染下一次会话', afterStop.sessionId === null && afterStop.paused === true && afterStop.autoQueueIds.length === 0 && orch.inflight.length === 0, {
    sessionId: afterStop.sessionId,
    paused: afterStop.paused,
    autoQueueIds: afterStop.autoQueueIds,
    inflight: orch.inflight.length,
    prepStatus: afterStop.prepStatus,
  })

  /* ---- 3.5 刷新不新建会话、不自动出声、不重复播放任务 ---- */
  await post('/api/_test/codex-mode', { mode: 'success' })
  await startPlaying([t1.id])
  const beforeReload = await state()
  const dbBefore = openDb()
  const playsBefore = dbBefore.prepare('SELECT COUNT(*) n FROM plays').get().n
  dbBefore.close()
  await loadPage()
  await waitFor(async () => (await state()).sessionId !== null, { timeout: 20000, label: '刷新后重连会话' })
  await sleep(1500)
  const afterReload = await state()
  const dbAfter = openDb()
  const playsAfter = dbAfter.prepare('SELECT COUNT(*) n FROM plays').get().n
  const openSessions = dbAfter.prepare('SELECT COUNT(*) n FROM sessions WHERE ended_at IS NULL').get().n
  dbAfter.close()
  check('网页：刷新只重连同一会话，不自动出声、不新建会话、不产生重复播放任务', afterReload.sessionId === beforeReload.sessionId && afterReload.paused === true && afterReload.audioSrc === '' && openSessions === 1 && playsAfter === playsBefore, {
    before: beforeReload.sessionId,
    after: afterReload.sessionId,
    paused: afterReload.paused,
    audioSrc: afterReload.audioSrc,
    openSessions,
    playsBefore,
    playsAfter,
  })

  /* ---- 3.6 快速切歌不被补歌覆盖 ---- */
  await post('/api/_test/codex-mode', { mode: 'slow', delayMs: 3500 })
  await startPlaying([t1.id, t2.id, tracks[2].id])
  await waitFor(async () => (await state()).refill.inFlight === true, { timeout: 10000, label: '补歌进入在途（切歌用例）' })
  // 先等第一首真正开始
  await page.click('#next')
  await sleep(120)
  await page.click('#next')
  await waitFor(async () => {
    const s = await state()
    return s.currentId === tracks[2].id && !s.paused
  }, { timeout: 30000, label: '快速切歌到最后选择' })
  await waitFor(async () => (await state()).refill.inFlight === false, { timeout: 20000, label: '补歌完成' })
  await sleep(800)
  const quick = await state()
  check('网页：补歌结果不会覆盖用户快速切歌的选择', quick.currentId === tracks[2].id && quick.paused === false, {
    currentId: quick.currentId,
    expected: tracks[2].id,
    paused: quick.paused,
  })

  /* ---- 3.7 Codex 失败时降级续播 ---- */
  await post('/api/_test/codex-mode', { mode: 'quota' })
  await setSettings({ refillThreshold: '5', refillBatchSize: '3' })
  await page.evaluate(() => window.__radio.__test.setConfig({ threshold: 5, batchSize: 3 }))
  await startPlaying([t1.id])
  await waitFor(async () => (await state()).queueLength > 1, { timeout: 30000, label: '降级批次到达' })
  const degraded = await state()
  check('网页：Codex 失败时用曲库候选降级续播，界面说明清楚，播放不中断', degraded.queueLength > 1 && degraded.paused === false && /Codex 暂不可用|降级/.test(degraded.prepStatus) && degraded.autoQueueIds.length > 0, {
    queueLength: degraded.queueLength,
    prepStatus: degraded.prepStatus,
    paused: degraded.paused,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-12-degraded-continue.png') })
  // 降级补入的歌曲要真的能播，而不只是追加进队列
  await seekEnd()
  await waitFor(
    async () => {
      const s = await state()
      return s.autoQueueIds.includes(s.currentId) && !s.paused && s.currentTime > 0.5
    },
    { timeout: 20000, label: '播放降级补入的歌曲' },
  )
  const degradedPlay = await state()
  check('网页：降级补入的歌曲能真实播放', degradedPlay.autoQueueIds.includes(degradedPlay.currentId) && degradedPlay.paused === false, {
    currentId: degradedPlay.currentId,
    fromDegradedBatch: degradedPlay.autoQueueIds,
    currentTime: +degradedPlay.currentTime.toFixed(2),
  })

  /* ---- 3.8 候选不足时清楚说明并停止自动重试 ---- */
  await post('/api/_test/codex-mode', { mode: 'success' })
  await page.evaluate(() =>
    window.__radio.__test.setConfig({ threshold: 5, batchSize: 3, backoffBaseMs: 800, backoffMaxMs: 800, maxAttempts: 2 }),
  )
  await post('/api/_test/refill-forced', {
    code: 'candidates_exhausted',
    message: '（测试注入）排除当前与已排队歌曲后没有新候选',
    count: 9,
  })
  await startPlaying([t1.id])
  await waitFor(
    async () => (await state()).refill.state === 'waiting_recovery',
    { timeout: 20000, interval: 250, label: '进入等待恢复' },
  )
  const exhaustedUi = await state()
  const attemptsAtLimit = exhaustedUi.refill.attempts
  await sleep(2500)
  const exhaustedAfter = await state()
  check(
    '网页：候选不足时给出明确状态并进入等待恢复（不再自动重试）',
    exhaustedUi.refill.state === 'waiting_recovery' &&
      /候选不足|补歌已暂停|没有可完整播放/.test(exhaustedUi.prepStatus) &&
      exhaustedAfter.refill.attempts === attemptsAtLimit,
    {
      state: exhaustedUi.refill.state,
      attempts: attemptsAtLimit,
      attemptsAfterWait: exhaustedAfter.refill.attempts,
      prepStatus: exhaustedUi.prepStatus,
    },
  )
  await post('/api/_test/refill-forced', { count: 0 })
  await page.evaluate(() => window.__radio.__test.setConfig({ threshold: 1, batchSize: 3, backoffBaseMs: 30000, maxAttempts: 5 }))

  await post('/api/session/stop')
  await browser.close()
}

/* ================= 主流程 ================= */

async function main() {
  if (!EXTERNAL_BASE) await startIsolatedServer()
  const health = await api('/api/health')
  if (!health.ok || !health.testHooks) throw new Error('需要 RADIO_TEST_HOOKS=1 的服务')
  if (!health.loggedIn) throw new Error('未登录：请先扫码登录')
  log(`服务在线：${health.account.nickname}（${BASE}）${EXTERNAL_BASE ? '' : ' · 独立数据库'}\n`)

  log('— 1. 编排控制器单元行为 —')
  await runControllerUnitChecks()

  log('\n— 2. 服务端补歌协调 —')
  await runServerChecks()

  log('\n— 3. 真实 Codex 补歌 —')
  await runRealCodexRefill()

  log('\n— 4. 真实浏览器：跨批续播与控制边界 —')
  const tracks = await pickPlayableTracks(4)
  if (tracks.length < 4) throw new Error('可完整播放的候选不足 4 首，无法做浏览器验证')
  report.evidence.tracks = tracks.map((t) => ({ id: t.id, name: t.name }))
  await runBrowserChecks(tracks)

  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
  }
  fs.writeFileSync(path.join(OUT, 'orchestration.json'), JSON.stringify(report, null, 2), 'utf-8')
  log(`\n结果：${report.summary.passed} 通过 / ${report.summary.failed} 失败`)
  log(`证据：${path.relative(ROOT, path.join(OUT, 'orchestration.json'))}`)
  if (report.summary.failed) process.exitCode = 1
}

main()
  .catch((err) => {
    report.fatal = String(err.stack || err.message)
    fs.writeFileSync(path.join(OUT, 'orchestration.json'), JSON.stringify(report, null, 2), 'utf-8')
    console.error('验证中止：', err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await post('/api/_test/codex-mode', { mode: 'off' })
      await post('/api/_test/refill-forced', { count: 0 })
      await post('/api/_test/refill-forced-picks', { ids: [] })
      await post('/api/_test/unplayable-next', { count: 0 })
      await post('/api/_test/resolve-error-next', { count: 0 })
    } catch (_) {}
    try {
      if (reportBrowser) await reportBrowser.close()
    } catch (_) {}
    stopIsolatedServer()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })
