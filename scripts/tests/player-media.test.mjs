import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// 真正交给浏览器解码的短音频；控制 HTTP 到达顺序，不伪造 playing 事件。
function makeWav() {
  const sampleRate = 8000
  const audio = Buffer.alloc(44 + sampleRate * 20 * 2)
  audio.write('RIFF')
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(sampleRate, 24)
  audio.writeUInt32LE(sampleRate * 2, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(audio.length - 44, 40)
  return audio
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('DJ 开启但缺少配置时，页面加载即显示具体缺项和下一步', { timeout: 15000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-config-test-'))
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, args: ['--mute-audio'] })
  t.after(async () => {
    await browser.close()
    fs.renameSync(profile, path.join(os.homedir(), '.Trash', path.basename(profile)))
  })
  const page = await browser.newPage()
  let voice = { ready: false, code: 'not_configured', message: '未配置 Fish 密钥：请设置 FISH_API_KEY 并重启服务。', voiceReferenceId: null }
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname
    let body
    if (pathname === '/api/settings') body = { ok: true, settings: { djEnabled: 'true' }, djVoice: voice }
    else if (pathname === '/api/library') body = { account: null, liked: { count: 0, tracks: [] }, playlists: { total: 0, created: [], collected: [] } }
    else if (pathname === '/api/feedback') body = { ok: true, active: [] }
    else if (pathname === '/api/session') body = { ok: true, session: null }
    if (body) return req.respond({ contentType: 'application/json', body: JSON.stringify(body) })
    const name = pathname === '/' ? 'index.html' : path.basename(pathname)
    const file = path.join(publicDir, name)
    if (!fs.existsSync(file)) return req.respond({ status: 404 })
    return req.respond({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) })
  })
  await page.goto('http://radio.fixture/', { waitUntil: 'networkidle0' })
  assert.match(await page.$eval('#djStatus', (el) => el.textContent), /FISH_API_KEY.*重启/)
  voice = { ready: false, code: 'not_configured', message: '尚未选择正式音色：停止收听后填写音色 reference_id，试听后保存。', voiceReferenceId: null }
  await page.reload({ waitUntil: 'networkidle0' })
  assert.match(await page.$eval('#djStatus', (el) => el.textContent), /正式音色.*试听/)
  voice = { ready: true, code: null, message: '', voiceReferenceId: 'chosen-voice' }
  await page.reload({ waitUntil: 'networkidle0' })
  assert.doesNotMatch(await page.$eval('#djStatus', (el) => el.textContent), /未配置|尚未选择/)
  assert.equal(await page.$eval('#previewVoice', (el) => el.value), 'chosen-voice')
})

test('切歌期间旧音频开始播放不替新歌记历史；新歌实际播放及暂停恢复正常记账', { timeout: 20000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-media-test-'))
  const oldAudio = deferred()
  const newResolve = deferred()
  const audio = makeWav()
  const tracks = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, name: `测试曲${i}`, artists: 'Fixture', durationMs: 20000 }))
  const session = { id: 'fixture-session', adjustments: {} }
  const json = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const serveAudio = (res) => {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length })
    res.end(audio)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    switch (url.pathname) {
      case '/api/library': return json(res, { account: { nickname: 'Fixture', userId: 1 }, liked: { count: 6, tracks }, playlists: { total: 0, created: [], collected: [] } })
      case '/api/settings': return json(res, { ok: true, settings: { djEnabled: 'false' } })
      case '/api/feedback': return json(res, { ok: true, active: [] })
      case '/api/session': return json(res, { ok: true, session: null })
      case '/api/session/start': return json(res, { ok: true, session })
      case '/api/plays/start': return json(res, { ok: true, session, playId: 'fixture-play' })
      case '/api/plays/end': return json(res, { ok: true })
      case '/api/resolve/100': return json(res, { ok: true, playable: true, audioUrl: '/api/audio/100' })
      case '/api/resolve/101': newResolve.resolve(res); return
      case '/api/audio/100': oldAudio.resolve(res); return
      case '/api/audio/101': return serveAudio(res)
      default: {
        const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname)
        const file = path.join(publicDir, name)
        if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return }
        res.setHeader('content-type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html')
        res.end(fs.readFileSync(file))
      }
    }
  })
  let browser
  t.after(async () => {
    try {
      if (browser) await browser.close()
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      const trash = path.join(os.homedir(), '.Trash')
      fs.mkdirSync(trash, { recursive: true })
      fs.renameSync(profile, path.join(trash, path.basename(profile)))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const plays = []
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.url() === `${base}/api/plays/start`) plays.push(JSON.parse(req.postData()))
    if (new URL(req.url()).origin === base) req.continue()
    else req.abort()
  })
  await page.goto(base, { waitUntil: 'networkidle0' })
  await page.evaluate(() => {
    window.mediaEvents = []
    document.querySelector('#audio').addEventListener('playing', () => window.mediaEvents.push(document.querySelector('#audio').currentSrc))
  })

  await page.click('.track')
  const oldResponse = await oldAudio.promise
  await page.evaluate(() => document.querySelectorAll('.track')[1].click())
  const newResponse = await newResolve.promise
  serveAudio(oldResponse)
  await page.waitForFunction(() => window.mediaEvents.length === 1)
  assert.doesNotMatch(await page.$eval('#status', (el) => el.textContent), /播放中：测试曲1/)
  assert.deepEqual(plays, [], '新歌尚未取得音源，不能写入播放记录')

  json(newResponse, { ok: true, playable: true, audioUrl: '/api/audio/101' })
  await page.waitForFunction(() => document.querySelector('#audio').currentSrc.includes('/api/audio/101') && document.querySelector('#audio').currentTime > 0.2 && document.querySelector('#session').textContent.includes('fixture-session'))
  assert.deepEqual(plays.map((p) => p.trackId), [101], '新歌真正出声后应记录一次')
  await page.click('#play')
  assert.equal(await page.$eval('#audio', (el) => el.paused), true)
  await page.click('#play')
  await page.waitForFunction(() => window.mediaEvents.length === 3)
  assert.deepEqual(plays.map((p) => p.trackId), [101], '暂停恢复不重复记账')
})
