import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer, { type Browser } from 'puppeteer-core'
import { moveToTrash } from '../lib/trash.mts'

test('登录：空 502 显示连接错误，恢复后用户可重试获取二维码', { timeout: 20000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-login-test-'))
  let browser: Browser
  t.after(async () => { await browser?.close(); moveToTrash(profile) })
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile })
  const page = await browser.newPage()
  let available = false, malformed = false, polls = 0
  const errors: string[] = []
  page.on('pageerror', e => errors.push((e instanceof Error ? e.message : String(e))))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const p = new URL(request.url()).pathname
    if (p === '/api/login/qr' && malformed) return void request.respond({ status: 200, body: '' })
    if (p === '/api/login/qr') return void request.respond(available
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'fixture', qrimg: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }) }
      : { status: 502, body: '' })
    if (p === '/api/login/poll') { polls++; return void request.respond({ status: 200, contentType: 'application/json', body: '{"code":801}' }) }
    if (request.url().startsWith('data:')) return void request.continue()
    const file = path.resolve('apps/web/dist', p.startsWith('/assets/') ? p.slice(1) : 'index.html')
    void request.respond({ status: 200, contentType: p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) })
  })
  await page.goto('http://radio.test/login', { waitUntil: 'networkidle0' })
  const text = await page.$eval('main', el => el.textContent)
  assert.match(text, /无法连接登录服务/)
  assert.doesNotMatch(text, /Unexpected end|JSON input/)
  assert.equal(polls, 0)
  malformed = true
  await page.locator('button').click()
  await page.waitForFunction(() => document.querySelector('main')!.textContent.includes('获取二维码失败'))
  assert.match(await page.$eval('main', el => el.textContent), /登录服务返回的数据不完整/)
  malformed = false
  available = true
  await page.locator('button').click()
  await page.waitForSelector('img[alt="登录二维码"]', { timeout: 3000 })
  assert.match(await page.$eval('main', el => el.textContent), /请用网易云音乐 App 扫码/)
  assert.deepEqual(errors, [])
})

test('登录：刷新作废旧二维码与旧轮询成功，页面只显示新一轮', { timeout: 20000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-login-race-'))
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile })
  t.after(async () => { await browser.close(); moveToTrash(profile) })
  const page = await browser.newPage()
  const requests: import('puppeteer-core').HTTPRequest[] = []
  let oldPoll: import('puppeteer-core').HTTPRequest | null = null
  const qr = (key: string) => JSON.stringify({ key, qrimg: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><text>${key}</text></svg>`) })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/login/qr') { requests.push(request); return }
    if (url.pathname === '/api/login/poll') { oldPoll = request; return }
    if (request.url().startsWith('data:')) { void request.continue(); return }
    const file = path.resolve('apps/web/dist', url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html')
    void request.respond({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) })
  })
  await page.goto('http://radio.test/login', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('button'))
  while (!requests.length) await new Promise(resolve => setTimeout(resolve, 10))
  await page.locator('button').click()
  while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 10))
  await requests[1].respond({ status: 200, contentType: 'application/json', body: qr('current') })
  await page.waitForFunction(() => document.querySelector('img')?.src.includes('current'))
  await requests[0].respond({ status: 200, contentType: 'application/json', body: qr('obsolete') }).catch(() => {})
  while (!oldPoll) await new Promise(resolve => setTimeout(resolve, 20))
  const stalePoll = oldPoll as import('puppeteer-core').HTTPRequest
  await page.locator('button').click()
  while (requests.length < 3) await new Promise(resolve => setTimeout(resolve, 10))
  await requests[2].respond({ status: 200, contentType: 'application/json', body: qr('latest') })
  await stalePoll.respond({ status: 200, contentType: 'application/json', body: '{"code":803,"account":{"nickname":"obsolete"}}' }).catch(() => {})
  await page.waitForFunction(() => document.querySelector('img')?.src.includes('latest'))
  await new Promise(resolve => setTimeout(resolve, 3200))
  assert.equal(new URL(page.url()).pathname, '/login')
  assert.ok((await page.$eval('img', img => img.src)).includes('latest'))
  assert.doesNotMatch(await page.$eval('main', el => el.textContent), /登录成功/)
})
