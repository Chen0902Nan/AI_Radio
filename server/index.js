/**
 * 本地电台最小服务：网易云资料读取 + 完整歌曲网页播放。
 *
 * - 外部凭据只在本进程使用，网页只拿到 /api/audio/:id 这种同源地址。
 * - 音频通过本服务转发，避免把带鉴权参数的 CDN 直链暴露给前端，并统一处理 Range。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const ncm = require('./netease')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const TEST_HOOKS = process.env.RADIO_TEST_HOOKS === '1'

// 故障注入开关：只影响“解析音源”这一步，用于验证单曲失败换歌。
let injectResolveFailures = 0
// 故障注入开关：让接下来的 N 次 /api/audio 请求返回 502，
// 用于验证“播放中途音源失效 → 刷新地址”这条链路。
let injectAudioFailures = 0

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  let file = path.join(PUBLIC_DIR, rel)
  // /login 这类无扩展名路径映射到同名 .html
  if (!path.extname(file)) file += '.html'
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return true
  }
  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
  return true
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch (_) {
    return {}
  }
}

/* ---------- 音频转发 ---------- */

async function streamAudio(req, res, id) {
  if (injectAudioFailures > 0) {
    injectAudioFailures -= 1
    sendJson(res, 502, { code: 'injected_audio_failure', message: '（测试注入）音频流获取失败' })
    return
  }
  let info
  try {
    info = await ncm.resolveTrack(id)
  } catch (err) {
    sendJson(res, err.code === 'NOT_LOGGED_IN' ? 401 : 502, {
      code: err.code || 'resolve_error',
      message: err.message,
    })
    return
  }
  if (info.kind !== 'full') {
    sendJson(res, 409, {
      code: info.kind === 'trial' ? 'trial_only' : 'unplayable',
      message:
        info.kind === 'trial'
          ? '账号对该曲目只有试听片段权限，跳过'
          : '账号当前无权播放该曲目（或已下架/地区限制）',
      fee: info.fee,
    })
    return
  }

  const headers = {}
  if (req.headers.range) headers.range = req.headers.range
  headers['user-agent'] =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

  let upstream
  try {
    upstream = await fetch(info.url, { headers, redirect: 'follow' })
  } catch (err) {
    sendJson(res, 502, { code: 'upstream_error', message: String(err.message || err) })
    return
  }

  if (!upstream.ok && upstream.status !== 206) {
    sendJson(res, 502, {
      code: 'upstream_status',
      status: upstream.status,
      message: `音源 CDN 返回 ${upstream.status}`,
    })
    return
  }

  const passHeaders = {}
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
    const v = upstream.headers.get(h)
    if (v) passHeaders[h] = v
  }
  passHeaders['cache-control'] = 'no-store'
  res.writeHead(upstream.status, passHeaders)
  if (!upstream.body) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r))
      }
    }
  } catch (_) {
    /* 客户端中断播放 */
  }
  res.end()
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname

  if (p === '/favicon.ico') {
    res.writeHead(204)
    return res.end()
  }

  try {
    if (p === '/api/health') {
      const me = await ncm.whoami()
      return sendJson(res, 200, {
        ok: true,
        loggedIn: Boolean(me),
        account: me,
        testHooks: TEST_HOOKS,
      })
    }

    if (p === '/api/login/qr') {
      const qr = await ncm.qrCreate()
      return sendJson(res, 200, qr)
    }

    if (p === '/api/login/poll') {
      const key = url.searchParams.get('key')
      if (!key) return sendJson(res, 400, { code: 400, message: '缺少 key' })
      const r = await ncm.qrCheck(key)
      const me = r.code === 803 ? await ncm.whoami() : null
      return sendJson(res, 200, { ...r, account: me })
    }

    if (p === '/api/library') {
      const session = ncm.loadSession()
      if (!session) return sendJson(res, 401, { code: 'NOT_LOGGED_IN', message: '未登录' })
      const uid = (session.profile && session.profile.userId) || 0
      const ids = await ncm.getLikedIds(session.cookie)
      const tracks = await ncm.getLikedTracks(session.cookie, ids)
      const playlists = await ncm.getUserPlaylists(session.cookie, uid)
      return sendJson(res, 200, {
        account: await ncm.whoami(),
        liked: { count: tracks.length, tracks },
        playlists,
      })
    }

    if (p.startsWith('/api/playlist/')) {
      const id = p.split('/').pop()
      const session = ncm.loadSession()
      if (!session) return sendJson(res, 401, { code: 'NOT_LOGGED_IN' })
      const r = await ncm.getPlaylistTracks(session.cookie, id)
      return sendJson(res, 200, r)
    }

    if (p.startsWith('/api/resolve/')) {
      const id = p.split('/').pop()
      if (injectResolveFailures > 0) {
        injectResolveFailures -= 1
        return sendJson(res, 502, {
          code: 'injected_failure',
          message: '（测试注入）该曲目音源解析失败',
        })
      }
      const force = url.searchParams.get('force') === '1'
      const info = await ncm.resolveTrack(id, { force })
      const kindCode =
        info.kind === 'full' ? 'ok' : info.kind === 'trial' ? 'trial_only' : 'unplayable'
      const kindMessage =
        info.kind === 'full'
          ? ''
          : info.kind === 'trial'
            ? '账号对该曲目只有试听片段权限，跳过'
            : '账号当前无权播放该曲目（或已下架/地区限制）'
      return sendJson(res, 200, {
        id: info.id,
        code: kindCode,
        message: kindMessage,
        kind: info.kind,
        identityKind: info.identity === 'anon' ? 'anon' : 'user',
        level: info.level,
        br: info.br,
        fee: info.fee,
        playable: info.kind === 'full',
        cached: info.cached,
        audioUrl: info.kind === 'full' ? `/api/audio/${info.id}` : null,
      })
    }

    if (p.startsWith('/api/audio/')) {
      const id = p.split('/').pop()
      return await streamAudio(req, res, id)
    }

    if (p === '/api/_test/fail-next' && TEST_HOOKS) {
      const body = await readBody(req)
      injectResolveFailures = Number(body.count ?? 1)
      return sendJson(res, 200, { ok: true, pendingFailures: injectResolveFailures })
    }

    if (p === '/api/_test/fail-audio-next' && TEST_HOOKS) {
      // 模拟音源 CDN 中途失效，用于验证刷新地址的链路
      const body = await readBody(req)
      injectAudioFailures = Number(body.count ?? 1)
      return sendJson(res, 200, { ok: true, pendingAudioFailures: injectAudioFailures })
    }

    if (p === '/api/_test/unplayable-next' && TEST_HOOKS) {
      // 模拟“刷新后确认该曲不可播放”，用于验证缓存失效路径（与上面的解析报错不同）
      const body = await readBody(req)
      const pending = ncm.setInjectedUnplayable(Number(body.count ?? 1))
      return sendJson(res, 200, { ok: true, pendingUnplayable: pending })
    }

    if (p === '/api/logout') {
      ncm.clearSession()
      return sendJson(res, 200, { ok: true })
    }

    if (serveStatic(res, p)) return
  } catch (err) {
    sendJson(res, 500, { code: 'server_error', message: String((err && err.message) || err) })
  }
})

server.listen(PORT, HOST, async () => {
  console.log(`[radio] http://${HOST}:${PORT}`)
  if (TEST_HOOKS) console.log('[radio] 测试注入已启用 (RADIO_TEST_HOOKS=1)')
  try {
    await ncm.init()
    console.log('[radio] 网易云匿名会话已就绪')
  } catch (err) {
    console.error('[radio] 初始化失败:', err.message)
  }
  const me = await ncm.whoami()
  console.log(
    me ? `[radio] 已登录：${me.nickname} (uid=${me.userId})` : '[radio] 未登录，请打开 /login 扫码',
  )
})
