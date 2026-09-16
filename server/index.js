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
const codex = require('./codex')
const db = require('./db')
const orchestrator = require('./orchestrator')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const TEST_HOOKS = process.env.RADIO_TEST_HOOKS === '1'

// 故障注入开关：只影响“解析音源”这一步，用于验证单曲失败换歌。
let injectResolveFailures = 0
// 故障注入开关：让接下来的 N 次 /api/audio 请求返回 502，
// 用于验证“播放中途音源失效 → 刷新地址”这条链路。
let injectAudioFailures = 0
// 故障注入开关：让接下来的 N 次补歌请求直接返回指定错误，
// 用于验证网页对候选不足/服务不可用的状态提示与有界重试。
let forcedRefillError = null
// 故障注入开关：让接下来的 N 次补歌请求返回指定曲目（仍逐首过可播性），
// 用于确定性验证「补歌返回已播过的歌」这类场景。
let forcedRefillPicks = null

db.init()
// 服务重启后，上一条开着但已无心跳的会话不再算进行中；网页刷新只会连上当前会话
try {
  const closed = db.closeStaleSessions('server_restart')
  if (closed.closed) console.log(`[radio] 已收尾上次未结束的会话 ${closed.id}`)
} catch (err) {
  console.error('[radio] 收尾旧会话失败：', err.message)
}

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

/* ---------- 曲库缓存与候选抽样 ---------- */

const libraryCache = new Map() // identity -> { at, tracks }
const LIBRARY_TTL_MS = 5 * 60 * 1000

async function getLikedTracksCached(session) {
  const key = ncm.currentIdentity()
  const hit = libraryCache.get(key)
  if (hit && Date.now() - hit.at < LIBRARY_TTL_MS) return hit.tracks
  const ids = await ncm.getLikedIds(session.cookie)
  const tracks = await ncm.getLikedTracks(session.cookie, ids)
  libraryCache.set(key, { at: Date.now(), tracks })
  return tracks
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

    if (p === '/api/_test/resolve-error-next' && TEST_HOOKS) {
      // 模拟“音源接口整体报错”，用于验证音乐服务不可用时的降级与退避
      const body = await readBody(req)
      const pending = ncm.setInjectedResolveErrors(Number(body.count ?? 1))
      return sendJson(res, 200, { ok: true, pendingResolveErrors: pending })
    }

    if (p === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req)
      const session = ncm.loadSession()
      if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN', message: '未登录' })

      const library = await getLikedTracksCached(session)
      const candidates = orchestrator.sampleCandidates(
        library,
        Number(body.candidateCount) || db.getNumberSetting('candidateCount', 60),
      )
      const result = await codex.pickTracks({
        candidates,
        brief: typeof body.brief === 'string' ? body.brief.slice(0, 200) : '',
        count: Number(body.count) || db.getNumberSetting('pickCount', 5),
        timeoutMs: Number(body.timeoutMs) || undefined,
      })

      // Codex 失败：不抛错，让前端明确知道要沿用原队列
      if (!result.ok) {
        return sendJson(res, 502, {
          ok: false,
          code: result.code,
          message: result.message,
          rejected: result.rejected || [],
          meta: { ...result.meta, candidateIds: candidates.map((c) => c.id) },
        })
      }

      // 模型给的 id 只算候选，必须再过一遍账号可播性才允许进入队列
      const checked = await orchestrator.checkPlayable(result.picks)
      const playable = checked.filter((c) => c.playable)
      if (!playable.length) {
        return sendJson(res, 502, {
          ok: false,
          code: 'no_playable',
          message: 'Codex 选出的曲目当前都不可完整播放，继续使用原队列',
          rejected: result.rejected || [],
          picks: checked,
          meta: { ...result.meta, candidateIds: candidates.map((c) => c.id) },
        })
      }

      return sendJson(res, 200, {
        ok: true,
        picks: playable,
        dropped: checked.filter((c) => !c.playable),
        rejected: result.rejected || [],
        meta: { ...result.meta, candidateIds: candidates.map((c) => c.id) },
      })
    }

    if (p === '/api/_test/sample-candidates' && TEST_HOOKS) {
      // 只跑真实抽样函数，不调 Codex；用于验证反馈加权与重复降权
      const session = ncm.loadSession()
      if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN' })
      const library = await getLikedTracksCached(session)
      const n = Number(url.searchParams.get('n')) || 20
      const picked = orchestrator.sampleCandidates(library, n)
      return sendJson(res, 200, { ok: true, ids: picked.map((t) => t.id), librarySize: library.length })
    }

    if (p === '/api/_test/codex-mode' && TEST_HOOKS) {
      const body = await readBody(req)
      const mode = codex.setCodexMode(body.mode, { delayMs: body.delayMs })
      return sendJson(res, 200, { ok: true, mode, stats: codex.getStats() })
    }

    if (p === '/api/_test/codex-stats' && TEST_HOOKS) {
      if (url.searchParams.get('reset') === '1') codex.resetStats()
      return sendJson(res, 200, { ok: true, stats: codex.getStats() })
    }

    if (p === '/api/_test/orchestrator-state' && TEST_HOOKS) {
      return sendJson(res, 200, { ok: true, inflight: orchestrator.inflightInfo() })
    }

    if (p === '/api/_test/clear-url-cache' && TEST_HOOKS) {
      ncm.clearUrlCache()
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/_test/refill-forced' && TEST_HOOKS) {
      const body = await readBody(req)
      const count = Number(body.count ?? 1)
      forcedRefillError =
        count > 0
          ? { code: body.code || 'candidates_exhausted', message: body.message || '（测试注入）补歌失败', remaining: count }
          : null
      return sendJson(res, 200, { ok: true, forced: forcedRefillError })
    }

    if (p === '/api/_test/refill-forced-picks' && TEST_HOOKS) {
      const body = await readBody(req)
      forcedRefillPicks =
        Array.isArray(body.ids) && body.ids.length
          ? { ids: body.ids.map(Number).filter(Number.isFinite), remaining: Number(body.count ?? 1) }
          : null
      return sendJson(res, 200, { ok: true, forcedPicks: forcedRefillPicks })
    }

    if (p === '/api/queue/refill' && req.method === 'POST') {
      const body = await readBody(req)

      if (forcedRefillError && forcedRefillError.remaining > 0) {
        forcedRefillError.remaining -= 1
        const code = forcedRefillError.code
        const status = code === 'candidates_exhausted' || code === 'session_ended' ? 409 : code === 'music_unavailable' ? 503 : 502
        return sendJson(res, status, { ok: false, code, message: forcedRefillError.message })
      }

      if (forcedRefillPicks && forcedRefillPicks.remaining > 0) {
        forcedRefillPicks.remaining -= 1
        const session = ncm.loadSession()
        if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN', message: '未登录' })
        let library = []
        try {
          library = await getLikedTracksCached(session)
        } catch (_) {}
        const byId = new Map(library.map((t) => [Number(t.id), t]))
        const checked = await orchestrator.checkPlayable(
          forcedRefillPicks.ids.map((id) => {
            const t = byId.get(Number(id)) || {}
            return {
              id: Number(id),
              name: t.name || `测试曲目 ${id}`,
              artists: t.artists || '',
              album: t.album || '',
              durationMs: t.durationMs || 0,
              reason: '（测试注入）强制返回的批次',
            }
          }),
        )
        const playable = checked.filter((c) => c.playable)
        if (!playable.length) {
          return sendJson(res, 502, { ok: false, code: 'no_playable', message: '（测试注入）强制批次都不可播' })
        }
        return sendJson(res, 200, {
          ok: true,
          picks: playable,
          dropped: checked.filter((c) => !c.playable),
          rejected: [],
          source: 'forced',
          degraded: false,
          meta: { forced: true, candidates: playable.length },
        })
      }

      const session = ncm.loadSession()
      if (!session) return sendJson(res, 401, { ok: false, code: 'NOT_LOGGED_IN', message: '未登录' })

      let library
      try {
        library = await getLikedTracksCached(session)
      } catch (err) {
        return sendJson(res, 503, {
          ok: false,
          code: 'library_unavailable',
          message: '读取红心歌曲失败，暂时无法补歌：' + err.message,
        })
      }

      const result = await orchestrator.prepareBatch({
        library,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        epoch: Number(body.epoch) || 0,
        excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds : [],
        count: Number(body.count) || db.getNumberSetting('refillBatchSize', 5),
        brief: typeof body.brief === 'string' ? body.brief.slice(0, 200) : '',
        timeoutMs: Number(body.timeoutMs) || undefined,
        skipCodex: Boolean(body.skipCodex),
      })

      if (result.ok) return sendJson(res, 200, result)
      const status =
        result.code === 'session_ended'
          ? 409
          : result.code === 'candidates_exhausted'
            ? 409
            : result.code === 'music_unavailable' || result.code === 'library_unavailable'
              ? 503
              : 502
      return sendJson(res, status, result)
    }

    if (p === '/api/session' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        session: db.getOpenSession(),
        feedback: db.feedbackSummary(),
      })
    }

    if (p === '/api/session/start' && req.method === 'POST') {
      // 已开启的会话直接复用：网页刷新只是重新连上，不会新建会话或重复播放任务
      return sendJson(res, 200, { ok: true, session: db.startSession() })
    }

    if (p === '/api/session/stop' && req.method === 'POST') {
      const open = db.getOpenSession()
      const ended = db.endSession('stopped')
      // 停止后旧补歌结果必须作废，不能污染下一次会话
      if (open) orchestrator.invalidateSession(open.id)
      return sendJson(res, 200, { ok: true, ...ended })
    }

    if (p === '/api/session/adjustment' && req.method === 'POST') {
      const body = await readBody(req)
      const session = db.getOpenSession()
      if (!session) return sendJson(res, 409, { ok: false, code: 'NO_SESSION', message: '当前没有进行中的收听会话' })
      if (!body.key) return sendJson(res, 400, { ok: false, message: '缺少 key' })
      const adjustments = db.setAdjustment(session.id, String(body.key), body.value)
      return sendJson(res, 200, { ok: true, adjustments })
    }

    if (p === '/api/feedback' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        active: db.listFeedback(),
        summary: db.feedbackSummary(),
      })
    }

    if (p === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req)
      const trackId = Number(body.trackId)
      if (!Number.isFinite(trackId)) return sendJson(res, 400, { ok: false, message: '缺少 trackId' })
      try {
        const session = db.getOpenSession()
        const row = db.addFeedback({
          trackId,
          trackName: body.trackName,
          artists: body.artists,
          sentiment: body.sentiment,
          source: body.source || 'ui',
          sessionId: session ? session.id : null,
        })
        return sendJson(res, 200, { ok: true, feedback: row, summary: db.feedbackSummary() })
      } catch (err) {
        return sendJson(res, 400, { ok: false, message: err.message })
      }
    }

    if (p.startsWith('/api/feedback/') && req.method === 'DELETE') {
      const trackId = Number(p.split('/').pop())
      const r = db.revokeFeedback(trackId)
      return sendJson(res, 200, { ok: true, ...r, summary: db.feedbackSummary() })
    }

    if (p === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, settings: db.listSettings() })
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.key) return sendJson(res, 400, { ok: false, message: '缺少 key' })
      const saved = db.setSetting(String(body.key), body.value)
      return sendJson(res, 200, { ok: true, setting: saved, settings: db.listSettings() })
    }

    if (p === '/api/plays/start' && req.method === 'POST') {
      const body = await readBody(req)
      const trackId = Number(body.trackId)
      if (!Number.isFinite(trackId)) return sendJson(res, 400, { ok: false, message: '缺少 trackId' })
      // 没有会话时按规格自动建立，避免播放记录脱离会话
      const session = db.getOpenSession() || db.startSession()
      const playId = db.recordPlay({
        sessionId: session.id,
        trackId,
        trackName: body.trackName,
        artists: body.artists,
      })
      return sendJson(res, 200, { ok: true, playId, session })
    }

    if (p === '/api/plays/end' && req.method === 'POST') {
      const body = await readBody(req)
      db.finishPlay(Number(body.playId), String(body.outcome || 'unknown'))
      return sendJson(res, 200, { ok: true })
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
