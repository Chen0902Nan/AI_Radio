import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer, { type HTTPRequest } from 'puppeteer-core'
import { moveToTrash } from '../lib/trash.mts'
import { click, state, waitFor, waitState } from '../lib/browser-probe.mts'

const song = (id: number) => ({ id, name: `歌曲${id}`, artists: '测试', reason: '测试推荐', album: '', durationMs: 10000 })
function fixture() {
  const requests = { playlists: [] as HTTPRequest[], plans: [] as HTTPRequest[] }
  const respond = (request: HTTPRequest, body: unknown) => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const routes: Record<string, unknown> = {
    '/api/library': { account: null, liked: { count: 1, tracks: [song(1)] }, playlists: { created: [{ id: 9, name: '慢歌单', trackCount: 1 }], collected: [], total: 1 } },
    '/api/settings': { settings: { djEnabled: 'false' } },
    '/api/feedback': { active: [] }, '/api/session': { session: null }, '/api/session/stop': { ok: true },
  }
  async function route(request: HTTPRequest): Promise<void> {
    const pathname = new URL(request.url()).pathname
    if (pathname === '/api/session/start') return
    if (pathname === '/api/events') { await request.abort(); return }
    if (pathname === '/api/playlist/9') { requests.playlists.push(request); return }
    if (pathname === '/api/plan') { requests.plans.push(request); return }
    if (pathname in routes) { await respond(request, routes[pathname]); return }
    const file = path.resolve('apps/web/dist', pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html')
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html'
    await request.respond({ status: 200, contentType, body: fs.readFileSync(file) })
  }
  return { requests, respond, route }
}

test('来源意图：慢歌单不能覆盖后来的 Codex 队列或停止操作', { timeout: 20000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-source-intent-'))
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile })
  t.after(async () => { await browser.close(); moveToTrash(profile) })
  const page = await browser.newPage(), server = fixture()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => { void server.route(request) })
  await page.goto('http://radio.test/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button[title="慢歌单"]')
  await page.click('button[title="慢歌单"]')
  await waitFor(() => server.requests.playlists[0], '慢歌单请求')
  await click(page, '让 Codex 选歌')
  const plan = await waitFor(() => server.requests.plans[0], '选歌请求')
  await server.respond(plan, { picks: [song(999)] })
  await waitState(page, s => s.queue.some(t => t.trackId === 999), '新选歌已接纳')
  const received = page.waitForResponse(r => r.url().endsWith('/api/playlist/9'))
  await server.respond(server.requests.playlists[0], { tracks: [song(200)], returned: 1, trackCount: 1, via: 'fixture' })
  await (await received).text()
  // 页面完成本轮网络回调及两次绘制后检查，不能仅在旧结果尚未处理时断言。
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  assert.deepEqual((await state(page)).queue.map(t => t.trackId), [999])
  await page.click('button[title="慢歌单"]')
  await waitFor(() => server.requests.playlists[1], '第二次歌单请求')
  await click(page, '开播')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '暂停'))
  await click(page, '停止')
  await waitState(page, s => s.status === '已停止收听。', '停止已生效')
  const before = await state(page)
  await server.respond(server.requests.playlists[1], { ok: false, message: '迟到错误' })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  assert.equal((await state(page)).status, before.status)
  assert.equal(await page.$eval('audio', a => a.paused), true)
  assert.deepEqual(errors, [])
})
