import type { ProbeReport } from './lib/tool-types.d.ts'
/**
 * Codex 选歌最小验证。
 *
 * 覆盖：
 *  1. 真实 Codex 调用（本机 codex exec 复用订阅）→ 返回歌曲 id 与理由
 *  2. 模型输出校验：id 必须在候选集里、不重复、有理由；部分非法时只保留合法部分
 *  3. 可播性校验后接入播放队列，并在浏览器里真实播放其中一首
 *  4. 失败续播：超时 / 额度不足 / 输出无效 三种情况下队列不变、播放不中断
 *
 * 前置：服务端以 `npm run start:test` 启动（RADIO_TEST_HOOKS=1）并已登录。
 * 用法：node scripts/verify-codex.mts [--headful] [--skip-real] [--base=http://127.0.0.1:8787]
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
// 迁移后使用 Nest 编译产物的 CodexService 静态部分（原 server/codex.js）
const codexMod = require('../apps/api/dist/codex/codex.service.js')
const codex = { ...codexMod, pickTracks: (opts: any) => new codexMod.CodexService().pickTracks(opts) }

const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8787').split('=')[1]
const HEADLESS = !args.includes('--headful')
const SKIP_REAL = args.includes('--skip-real')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const report: ProbeReport & { checks: Array<{name: string; ok: unknown; detail?: unknown}>; evidence: Record<string, any> } = { at: new Date().toISOString(), base: BASE, checks: [], evidence: {} }
const log = (...a: string[]) => console.log(...a)
const sleep = (ms: number|undefined) => new Promise((r) => setTimeout(r, ms))

function check(name: string, ok: unknown, detail?: unknown) {
  report.checks.push({ name, ok, detail })
  log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
}

async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 60000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await sleep(interval)
  }
}

async function plan(body: { brief: string; count: number; candidateCount?: number }) {
  const res = await fetch(BASE + '/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  let data: Record<string, any> = {}
  try {
    data = await res.json()
  } catch (_) {}
  return { status: res.status, ...data } as Record<string, any> & {status: number}
}

async function setMode(mode: string) {
  const res = await fetch(BASE + '/api/_test/codex-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  return res.json()
}

/* ---------- 1. 真实 Codex 调用 ---------- */

async function runRealCall() {
  if (SKIP_REAL) {
    log('  SKIP  真实 Codex 调用（--skip-real）')
    return null
  }
  const t0 = Date.now()
  const r = await plan({ brief: '深夜安静、适合一个人听', count: 4, candidateCount: 60 })
  const elapsed = Date.now() - t0
  if (!r.ok) {
    check('真实 Codex 调用返回可用结果', false, { status: r.status, code: r.code, message: r.message })
    return null
  }
  const candidateIds = new Set(r.meta.candidateIds)
  const ids = r.picks.map((p: { id: any }) => p.id)
  const allFromCandidates = ids.every((id: unknown) => candidateIds.has(id))
  check('真实 Codex 调用返回可用结果', r.picks.length > 0, {
    picks: r.picks.length,
    durationMs: r.meta.durationMs,
    exitCode: r.meta.exitCode,
    tokens: r.meta.tokens,
    wallMs: elapsed,
  })
  check('Codex 返回的 id 全部来自候选集（没有编造）', allFromCandidates, { ids, candidates: candidateIds.size })
  check('Codex 返回的每一首都有中文选歌理由', r.picks.every((p: { reason: string|any[] }) => p.reason && p.reason.length > 0), {
    reasons: r.picks.map((p: { reason: any }) => p.reason),
  })
  check('Codex 返回值用真实账号做过可播性校验', r.picks.every((p: { playable: boolean }) => p.playable === true), {
    kinds: r.picks.map((p: { kind: any }) => p.kind),
    dropped: r.dropped || [],
  })
  report.evidence.realCall = {
    brief: '深夜安静、适合一个人听',
    picks: r.picks.map((p: { id: any; name: any; artists: any; reason: any; kind: any }) => ({ id: p.id, name: p.name, artists: p.artists, reason: p.reason, kind: p.kind })),
    meta: { durationMs: r.meta.durationMs, exitCode: r.meta.exitCode, tokens: r.meta.tokens, candidates: r.meta.candidateIds.length },
    rejected: r.rejected,
  }
  return r
}

/* ---------- 2. 输出校验逻辑（合成输入自检） ---------- */

function runValidationSelfTest() {
  const candidates = [
    { id: 1, name: 'A', artists: 'a' },
    { id: 2, name: 'B', artists: 'b' },
    { id: 3, name: 'C', artists: 'c' },
  ]
  const cases = [
    ['全部合法', { picks: [{ id: 1, reason: 'r1' }, { id: 2, reason: 'r2' }] }, 2, 0, false],
    ['编造的 id 被拒', { picks: [{ id: 999, reason: 'r' }, { id: 1, reason: 'r1' }] }, 1, 1, false],
    ['重复被拒', { picks: [{ id: 1, reason: 'r1' }, { id: 1, reason: 'r1b' }] }, 1, 1, false],
    ['缺理由被拒', { picks: [{ id: 1, reason: '' }, { id: 2, reason: 'r2' }] }, 1, 1, false],
    ['id 不是数字被拒', { picks: [{ id: 'x', reason: 'r' }] }, 0, 1, false],
    ['结构不对', { nope: [] }, 0, 0, true],
    ['全部非法', { picks: [{ id: 999, reason: 'r' }, { id: 888, reason: 'r' }] }, 0, 2, false],
  ]
  const results = []
  for (const [name, raw, expectValid, expectRejected, expectStructural] of cases) {
    const r = codex.validatePicks(raw, candidates)
    results.push({
      name,
      valid: r.valid.length,
      rejected: r.rejected.length,
      structurallyInvalid: r.structurallyInvalid,
      ok: r.valid.length === expectValid && r.rejected.length === expectRejected && r.structurallyInvalid === expectStructural,
    })
  }
  const bad = results.filter((r) => !r.ok)
  check('模型输出校验逻辑自检（合成输入）', bad.length === 0, { cases: results.length, unexpected: bad })
  report.evidence.validationSelfTest = { cases: results, note: '合成输入只验证校验逻辑本身，真实结论看第 1 节' }
}

/* ---------- 3. 部分非法时只保留合法部分（服务端真实路径） ---------- */

async function runPartialCheck() {
  await setMode('partial')
  const r = await plan({ brief: '测试部分非法输出', count: 4 })
  await setMode('off')
  const rejectedIds = (r.rejected || []).map((x: { id: any }) => x.id)
  check('部分非法输出时只保留合法曲目、并记录被拒项', r.ok === true && r.picks.length > 0 && rejectedIds.length > 0, {
    status: r.status,
    kept: (r.picks || []).map((p: { id: any }) => p.id),
    rejected: r.rejected,
  })
  report.evidence.partial = { status: r.status, kept: r.picks, rejected: r.rejected }
}

/* ---------- 4/5. 浏览器：接入队列、真实播放、失败续播 ---------- */

async function runBrowserChecks() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 1000 })
  const state = () => page.evaluate(() => (window.__radio ? window.__radio.state : null))
  const srcId = (s: { audioSrc: string }) => {
    const m = s && s.audioSrc && s.audioSrc.match(/\/api\/audio\/(\d+)/)
    return m ? Number(m[1]) : null
  }

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await waitFor(
    async () => /^\d+$/.test(await page.$eval('#likedCount', (e) => e.textContent.trim())),
    { timeout: 90000, label: '音乐资料加载' },
  )

  // 先播一首，确认后续接入队列不打断它
  await page.click('#tracks .track:nth-child(1)')
  await waitFor(async () => {
    const s = await state()
    return s && srcId(s) === s.currentId && !s.paused && s.currentTime > 2
  }, { timeout: 40000, label: '基线播放开始' })
  const before = await state()

  // 触发真实 Codex 选歌
  await setMode('off')
  await page.type('#brief', '深夜安静、适合一个人听')
  await page.click('#plan')
  await waitFor(async () => (await state()).codexPicks.length > 0, { timeout: 90000, interval: 700, label: 'Codex 返回选歌' })
  const afterPlan = await state()

  const playingStillSame = afterPlan.currentId === before.currentId && !afterPlan.paused
  check('Codex 选歌接入队列时没有打断正在播放的歌曲', playingStillSame, {
    beforeId: before.currentId,
    afterId: afterPlan.currentId,
    paused: afterPlan.paused,
  })
  check('Codex 选出的歌接在当前播放之后（原曲仍在队首）', afterPlan.queueIds[0] === before.currentId && afterPlan.queueIds.length === afterPlan.codexPicks.length + 1, {
    queueLength: afterPlan.queueIds.length,
    picks: afterPlan.codexPicks.length,
    queueIds: afterPlan.queueIds,
  })
  check('界面上能看到 Codex 的选歌理由', afterPlan.codexPicks.every((p: { reason: string|any[] }) => p.reason && p.reason.length > 0), {
    picks: afterPlan.codexPicks,
  })
  await page.screenshot({ path: path.join(OUT, 'shot-05-codex-picks.png') })

  // 点 Codex 选的第一首，确认真实播放
  await page.click('#codexPicks .pick:nth-child(1)')
  const firstPick = afterPlan.codexPicks[0]
  await waitFor(async () => {
    const s = await state()
    return s && s.currentId === firstPick.id && srcId(s) === firstPick.id && !s.paused && s.currentTime > 2
  }, { timeout: 40000, label: '播放 Codex 选出的第一首' })
  const playingPick = await state()
  check('Codex 选出的歌能在网页里真实播放', playingPick.currentTime > 2 && !playingPick.paused, {
    id: playingPick.currentId,
    title: playingPick.currentTitle,
    currentTime: +playingPick.currentTime.toFixed(2),
    duration: +playingPick.duration.toFixed(2),
    reason: firstPick.reason,
  })
  report.evidence.browserApply = { before, afterPlan, playingPick }
  await page.screenshot({ path: path.join(OUT, 'shot-06-codex-playing.png') })

  // 三种失败都要保持原队列、不中断播放。
  // 基线只取一次：否则第一个用例把队列弄坏后，后面的“未变化”会变成空过。
  const baselineFail = await state()
  for (const mode of ['timeout', 'quota', 'invalid']) {
    const beforeFail = await state()
    await setMode(mode)
    await page.click('#plan')
    await waitFor(async () => /失败/.test((await state()).codexStatus), { timeout: 30000, interval: 300, label: `${mode} 失败提示` })
    await sleep(2500)
    const afterFail = await state()
    const queueSame = JSON.stringify(afterFail.queueIds) === JSON.stringify(baselineFail.queueIds)
    const picksSame = JSON.stringify(afterFail.codexPicks) === JSON.stringify(baselineFail.codexPicks)
    check(`Codex ${mode} 失败时沿用原队列且播放不中断`,
      queueSame && picksSame && afterFail.currentId === baselineFail.currentId && !afterFail.paused && afterFail.currentTime > beforeFail.currentTime, {
        mode,
        queueUnchanged: queueSame,
        picksUnchanged: picksSame,
        currentId: afterFail.currentId,
        baselineCurrentId: baselineFail.currentId,
        paused: afterFail.paused,
        advancedBy: +(afterFail.currentTime - beforeFail.currentTime).toFixed(2),
        status: afterFail.codexStatus,
      })
    report.evidence[`fallback_${mode}`] = { baseline: baselineFail, before: beforeFail, after: afterFail }
    await setMode('off')
  }
  await page.screenshot({ path: path.join(OUT, 'shot-07-codex-fallback.png') })

  await browser.close()
}

async function main() {
  const health = await (await fetch(BASE + '/api/health')).json()
  if (!health.ok || !health.testHooks) throw new Error('需要以 RADIO_TEST_HOOKS=1 启动服务')
  if (!health.loggedIn) throw new Error('未登录：请先扫码登录')
  log(`服务在线：${health.account.nickname}\n`)

  log('— 1. 真实 Codex 调用 —')
  await runRealCall()

  log('\n— 2. 模型输出校验（合成输入自检） —')
  runValidationSelfTest()

  log('\n— 3. 部分非法输出的处理 —')
  await runPartialCheck()

  log('\n— 4/5. 浏览器：接入队列、真实播放、失败续播 —')
  await runBrowserChecks()

  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
  }
  fs.writeFileSync(path.join(OUT, 'codex-plan.json'), JSON.stringify(report, null, 2), 'utf-8')
  log(`\n结果：${report.summary.passed} 通过 / ${report.summary.failed} 失败`)
  log(`证据：${path.relative(ROOT, path.join(OUT, 'codex-plan.json'))}`)
  if (report.summary.failed) process.exitCode = 1
}

main().catch(async (err) => {
  report.fatal = String(err.stack || (err instanceof Error ? err.message : String(err)))
  try {
    await setMode('off')
  } catch (_) {}
  fs.writeFileSync(path.join(OUT, 'codex-plan.json'), JSON.stringify(report, null, 2), 'utf-8')
  console.error('验证中止：', (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
})
