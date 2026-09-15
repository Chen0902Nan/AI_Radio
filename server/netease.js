/**
 * 网易云音乐只读接入层。
 *
 * 只使用标准接口读取本人账号资料与播放地址：
 *  - 不传 unblock / match / 第三方音源参数，不启用任何替代音源。
 *  - 只返回账号当前有权播放的内容；试听片段与不可播放分别标记，不当作完整歌曲。
 *
 * 凭据只保存在本机 data/ 目录，前端永远拿不到 cookie 或网易云 CDN 直链。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const api = require('@neteasecloudmusicapienhanced/api')
const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig')
const {
  getXeapiPublicKey,
} = require('@neteasecloudmusicapienhanced/api/util/xeapiKey')
const {
  generateRandomChineseIP,
} = require('@neteasecloudmusicapienhanced/api/util/index')

const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const NCM_TMP_DIR = path.join(DATA_DIR, 'ncm-tmp')
const SESSION_FILE = path.join(DATA_DIR, 'session.json')
const TMP = os.tmpdir()

// 包内部把这些文件放在系统临时目录；我们额外镜像到项目内，保证重启后不必重新注册。
const MIRRORED_FILES = ['anonymous_token', 'xeapi_public_key']

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(NCM_TMP_DIR, { recursive: true })

function mirrorToTmp() {
  for (const name of MIRRORED_FILES) {
    const src = path.join(NCM_TMP_DIR, name)
    const dst = path.join(TMP, name)
    try {
      const content = fs.readFileSync(src, 'utf-8')
      if (content.trim()) fs.writeFileSync(dst, content, 'utf-8')
    } catch (_) {
      /* 首次运行没有镜像文件，交给上游包自行获取 */
    }
  }
}

function mirrorFromTmp() {
  for (const name of MIRRORED_FILES) {
    const src = path.join(TMP, name)
    const dst = path.join(NCM_TMP_DIR, name)
    try {
      const content = fs.readFileSync(src, 'utf-8')
      if (content.trim()) fs.writeFileSync(dst, content, 'utf-8')
    } catch (_) {}
  }
}

let initPromise = null

async function init() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    mirrorToTmp()
    global.cnIp = global.cnIp || generateRandomChineseIP()
    let current = {}
    try {
      current = JSON.parse(
        fs.readFileSync(path.join(TMP, 'xeapi_public_key'), 'utf-8'),
      )
    } catch (_) {}
    if (!current.sk) {
      const key = await getXeapiPublicKey(current, global.deviceId || '')
      fs.writeFileSync(
        path.join(TMP, 'xeapi_public_key'),
        JSON.stringify(key),
        'utf-8',
      )
    }
    // 注册匿名 token（游客态），用于未登录时的辅助查询
    await generateConfig()
    mirrorFromTmp()
  })().catch((err) => {
    initPromise = null
    throw err
  })
  return initPromise
}

/* ---------- 会话（登录 cookie） ---------- */

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
    if (raw && typeof raw.cookie === 'string' && raw.cookie.includes('MUSIC_U')) {
      return raw
    }
  } catch (_) {}
  return null
}

function saveSession(cookie, profile) {
  const data = {
    cookie,
    savedAt: new Date().toISOString(),
    profile: profile || null,
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8')
  fs.chmodSync(SESSION_FILE, 0o600)
  return data
}

function clearSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE)
}

function requireSession() {
  const session = loadSession()
  if (!session) {
    const err = new Error('未登录：请先打开 /login 用网易云 App 扫码')
    err.code = 'NOT_LOGGED_IN'
    throw err
  }
  return session
}

/* ---------- 登录 ---------- */

async function qrCreate() {
  await init()
  const keyRes = await api.login_qr_key({})
  const key = keyRes.body && keyRes.body.data && keyRes.body.data.unikey
  if (!key) throw new Error('未能取得二维码 key')
  const qrRes = await api.login_qr_create({ key, qrimg: true, platform: 'web' })
  return { key, ...qrRes.body.data }
}

async function qrCheck(key) {
  await init()
  const res = await api.login_qr_check({ key })
  const body = res.body || {}
  const code = body.code
  if (code === 803) {
    const cookie = body.cookie || (res.cookie || []).join(';')
    const account = await api.user_account({ cookie })
    const profile = (account.body && account.body.profile) || null
    saveSession(cookie, profile)
  }
  return { code, message: body.message || '' }
}

async function whoami() {
  const session = loadSession()
  if (!session) return null
  try {
    const res = await api.login_status({ cookie: session.cookie })
    const profile = res.body && res.body.data && res.body.data.profile
    if (!profile) return null
    return {
      userId: profile.userId,
      nickname: profile.nickname,
      vipType: profile.vipType,
      savedAt: session.savedAt,
    }
  } catch (_) {
    return null
  }
}

/* ---------- 音乐资料（只读） ---------- */

/** 红心歌曲：likelist 一次返回全部 id，无分页。 */
async function getLikedIds(cookie) {
  const res = await api.likelist({ uid: 0, cookie })
  if (res.body.code !== 200) {
    throw new Error(`likelist 失败 code=${res.body.code}`)
  }
  const ids = res.body.ids || []
  return [...new Set(ids.map(Number))].filter((n) => Number.isFinite(n))
}

/**
 * 收藏 + 自建歌单。
 *
 * 实测发现 `/api/user/playlist` 的行为与文档直觉不同（2026-09-14，本账号 6 个歌单）：
 *  - `limit` 被服务端忽略，返回从 offset 到末尾的全部歌单；
 *  - `offset` 正常生效；
 *  - `more` 恒为 false，不能用来判断是否还有下一页。
 * 因此按“实际返回条数”推进 offset，并靠去重保证不会重复，而不是靠 more/limit。
 */
async function getUserPlaylists(cookie, uid, { pageSize = 50, maxPages = 40 } = {}) {
  const collected = []
  const created = []
  const seen = new Set()
  const log = []
  let offset = 0
  let pages = 0

  while (pages < maxPages) {
    const res = await api.user_playlist({ uid, limit: pageSize, offset, cookie })
    if (res.body.code !== 200) {
      throw new Error(`user_playlist 失败 code=${res.body.code} offset=${offset}`)
    }
    const list = res.body.playlist || []
    let added = 0
    for (const pl of list) {
      const key = `${pl.userId}:${pl.id}`
      if (seen.has(key)) continue
      seen.add(key)
      added += 1
      const item = {
        id: pl.id,
        name: pl.name,
        trackCount: pl.trackCount,
        playCount: pl.playCount,
        subscribed: pl.subscribed,
        creatorId: pl.userId,
        creator: pl.creator && pl.creator.nickname,
        privacy: pl.privacy,
      }
      if (pl.subscribed || pl.userId !== uid) collected.push(item)
      else created.push(item)
    }
    log.push({ offset, returned: list.length, added, more: res.body.more })
    pages += 1

    if (list.length === 0 || added === 0) break
    if (res.body.more !== true && list.length < pageSize) break
    offset += list.length
  }

  return { collected, created, pages: log, total: collected.length + created.length }
}

/**
 * 取歌单内歌曲。
 * 优先用 playlist_detail 的完整 trackIds（不截断），再分块取歌曲详情。
 * 如果 trackIds 明显少于 trackCount，退回 playlist_track_all 的 offset 分页。
 */
async function getPlaylistTracks(cookie, playlistId, { chunk = 300 } = {}) {
  const detail = await api.playlist_detail({ id: playlistId, cookie })
  if (detail.body.code !== 200) {
    throw new Error(`playlist_detail 失败 id=${playlistId} code=${detail.body.code}`)
  }
  const pl = detail.body.playlist
  const trackIds = (pl.trackIds || []).map((t) => t.id)
  let ids = trackIds
  let via = 'playlist_detail.trackIds'
  if (!ids.length || (pl.trackCount && ids.length < pl.trackCount)) {
    via = 'playlist_track_all'
    ids = []
    let offset = 0
    while (offset < (pl.trackCount || 0) + 1) {
      const res = await api.playlist_track_all({
        id: playlistId,
        limit: chunk,
        offset,
        cookie,
      })
      const songs = (res.body && res.body.songs) || []
      if (!songs.length) break
      ids.push(...songs.map((s) => s.id))
      offset += chunk
      if (songs.length < chunk) break
    }
  }

  const unique = [...new Set(ids)]
  const tracks = []
  for (let i = 0; i < unique.length; i += chunk) {
    const slice = unique.slice(i, i + chunk)
    const res = await api.song_detail({ ids: slice.join(','), cookie })
    if (res.body.code !== 200) {
      throw new Error(`song_detail 失败 code=${res.body.code}`)
    }
    const byId = new Map((res.body.songs || []).map((s) => [s.id, s]))
    for (const id of slice) {
      const s = byId.get(id)
      if (s) tracks.push(normalizeTrack(s))
    }
  }
  return { via, trackCount: pl.trackCount, returned: tracks.length, tracks }
}

/** 红心 id 批量取歌曲详情（song_detail 单次上限 1000，按 300 分块）。 */
async function getLikedTracks(cookie, ids, { chunk = 300 } = {}) {
  const tracks = []
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk)
    const res = await api.song_detail({ ids: slice.join(','), cookie })
    if (res.body.code !== 200) {
      throw new Error(`song_detail 失败 code=${res.body.code} offset=${i}`)
    }
    const byId = new Map((res.body.songs || []).map((s) => [s.id, s]))
    for (const id of slice) {
      const s = byId.get(id)
      if (s) tracks.push(normalizeTrack(s))
    }
  }
  return tracks
}

function normalizeTrack(s) {
  return {
    id: s.id,
    name: s.name,
    artists: (s.ar || s.artists || []).map((a) => a.name).join(' / '),
    album: (s.al || s.album || {}).name || '',
    durationMs: s.dt || s.duration || 0,
    fee: s.fee,
    mvId: s.mv || 0,
  }
}

/* ---------- 音源（不写回、无播放副作用） ---------- */

const urlCache = new Map()

function cacheGet(id) {
  const hit = urlCache.get(Number(id))
  if (!hit) return null
  if (hit.expiresAt - Date.now() < 60_000) {
    urlCache.delete(Number(id))
    return null
  }
  return hit
}

/**
 * 返回账号有权播放的音源信息并分类：
 *  - full  完整歌曲
 *  - trial 试听片段（freeTrialInfo 非空）
 *  - none  无地址（无权限 / 未上架 / 地区限制）
 */
async function resolveTrack(id, { force = false } = {}) {
  const key = Number(id)
  if (!force) {
    const cached = cacheGet(key)
    if (cached) return { ...cached, cached: true }
  }
  // 正常情况下必须已登录；只有在开启测试注入时才允许游客态解析，
  // 用于在拿到本人资料前验证播放链路本身。游客态同样受网易权限限制。
  const session = loadSession()
  const cookie = session
    ? session.cookie
    : process.env.RADIO_TEST_HOOKS === '1'
      ? ''
      : requireSession().cookie
  const res = await api.song_url_v1({ id: key, level: 'exhigh', cookie })
  if (res.body.code !== 200) {
    throw new Error(`song_url_v1 失败 code=${res.body.code}`)
  }
  const d = (res.body.data || [])[0] || {}
  const trial = d.freeTrialInfo && Object.keys(d.freeTrialInfo).length > 0
  const kind = !d.url ? 'none' : trial ? 'trial' : 'full'
  const info = {
    id: key,
    kind,
    url: d.url || null,
    br: d.br || 0,
    size: d.size || 0,
    type: d.type || null,
    level: d.level || null,
    fee: d.fee,
    freeTrialInfo: trial ? d.freeTrialInfo : null,
    expiresAt: Date.now() + Math.max(0, (d.expi || 1200) - 30) * 1000,
    cached: false,
  }
  if (info.url) urlCache.set(key, info)
  return info
}

module.exports = {
  init,
  qrCreate,
  qrCheck,
  whoami,
  loadSession,
  saveSession,
  clearSession,
  getLikedIds,
  getLikedTracks,
  getUserPlaylists,
  getPlaylistTracks,
  resolveTrack,
  normalizeTrack,
  DATA_DIR,
}
