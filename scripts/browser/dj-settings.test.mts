import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core'
import { moveToTrash } from '../lib/trash.mts'

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待浏览器请求超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function click(page: Page, label: string): Promise<void> {
  for (const button of await page.$$('button')) {
    if ((await button.evaluate(el => el.textContent.trim())) === label) { await button.click(); return }
  }
  throw new Error('找不到按钮：' + label)
}
function wav(): Buffer {
  const samples = 8000, buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}
function serveStatic(request: HTTPRequest, pathname: string): void {
  const file = path.resolve('apps/web/dist', pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html')
  const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html'
  void request.respond({ status: 200, contentType, body: fs.readFileSync(file) })
}
function fixture() {
  const previews = new Map<string, HTTPRequest>()
  const settingsReads: HTTPRequest[] = []
  const state = { settings: { djEnabled: 'true', djIntervalTracks: '4' }, failSave: false }
  const respond = (request: HTTPRequest, body: unknown, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
  function route(request: HTTPRequest): void {
    const url = new URL(request.url())
    if (url.pathname === '/api/events') { void request.abort(); return }
    if (url.pathname === '/api/settings') {
      if (request.method() === 'GET') { settingsReads.push(request); return }
      if (state.failSave) { void respond(request, { message: 'fixture save failure' }, 500); return }
      const body = JSON.parse(request.postData()!) as { key: keyof typeof state.settings; value: string }
      state.settings[body.key] = body.value
      void respond(request, { settings: state.settings }); return
    }
    if (url.pathname === '/api/dj/preview') {
      const body = JSON.parse(request.postData()!) as { referenceId: string }
      previews.set(body.referenceId, request); return
    }
    if (url.pathname.startsWith('/api/dj/audio/')) { void request.respond({ status: 200, contentType: 'audio/wav', body: wav() }); return }
    if (url.pathname === '/api/library') { void respond(request, { account: null, liked: { count: 0, tracks: [] }, playlists: { created: [], collected: [], total: 0 } }); return }
    if (url.pathname.startsWith('/api/')) { void respond(request, { ok: true, session: null, active: [] }); return }
    serveStatic(request, url.pathname)
  }
  return { previews, settingsReads, state, respond, route }
}

test('DJ 页面：旧设置不能重启 DJ、保存失败可见、乱序试听只播当前音色', { timeout: 20000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-dj-settings-'))
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile, args: ['--mute-audio'] })
  t.after(async () => { await browser.close(); moveToTrash(profile) })
  const page = await browser.newPage(), server = fixture()
  await page.setRequestInterception(true)
  page.on('request', server.route)
  await page.goto('http://radio.test/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="checkbox"]')
  await waitUntil(() => server.settingsReads.length > 0)
  await page.click('input[type="checkbox"]')
  await waitUntil(() => server.state.settings.djEnabled === 'false')
  await server.respond(server.settingsReads[0], { settings: { djEnabled: 'true', djIntervalTracks: '4' } })
  assert.equal(await page.$eval('input[type="checkbox"]', el => (el as HTMLInputElement).checked), false)
  server.state.failSave = true
  await page.click('input[type="checkbox"]')
  await page.waitForSelector('[role="alert"]')
  assert.match(await page.$eval('[role="alert"]', el => el.textContent), /fixture save failure/)
  assert.equal(await page.$eval('input[type="checkbox"]', el => (el as HTMLInputElement).checked), false)
  const input = 'input[placeholder^="音色 reference_id"]'
  await page.type(input, 'A'); await click(page, '试听')
  await waitUntil(() => server.previews.has('A'))
  await page.locator(input).fill('B'); await click(page, '试听')
  await waitUntil(() => server.previews.has('B'))
  await server.respond(server.previews.get('B')!, { audio: { assetId: 'B', url: '/api/dj/audio/B', durationMs: 1000, bytes: wav().length } })
  await page.waitForFunction(() => document.querySelector('audio')!.currentTime > 0)
  await server.respond(server.previews.get('A')!, { audio: { assetId: 'A', url: '/api/dj/audio/A', durationMs: 1000, bytes: wav().length } })
  assert.match(await page.$eval('audio', el => el.src), /\/B\?/)
  await page.locator(input).fill('C')
  const save = await page.$$('button')
  for (const button of save) if ((await button.evaluate(el => el.textContent.trim())) === '设为正式音色') assert.equal(await button.evaluate(el => el.disabled), true)
  assert.equal(await page.$eval('audio', el => el.paused), true)
})
