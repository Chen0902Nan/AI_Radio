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
