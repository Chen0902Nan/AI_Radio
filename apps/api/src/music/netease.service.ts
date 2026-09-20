/**
 * 网易云音乐只读接入（迁移自 server/netease.js）。
 *
 * 只使用标准接口读取本人账号资料与播放地址：不传 unblock / match / 第三方音源参数。
 * 只返回账号当前有权播放的内容；试听片段与不可播放分别标记，不当作完整歌曲。
 * 凭据只保存在本机 data/ 目录，前端永远拿不到 cookie 或网易云 CDN 直链。
 */
import { Injectable } from '@nestjs/common'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

// 上游社区包保持 CommonJS require 形态（不重新声明其类型）
import { createRequire } from 'node:module'
import { DATA_DIR, NCM_TMP_DIR, SESSION_FILE } from '../config/app-config'
import { body, record, list, text, integer, identifier, tracks as parseTracks, playlist as parsePlaylist, source as parseSource } from './netease-boundary'

const req2 = createRequire(__filename)
// This untyped CommonJS package is constrained at entry; every response stays unknown.
const api: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = req2('@neteasecloudmusicapienhanced/api')
const generateConfig: () => Promise<void> = req2('@neteasecloudmusicapienhanced/api/generateConfig')
const { getXeapiPublicKey }: { getXeapiPublicKey: (current: Record<string, unknown>, device: unknown) => Promise<unknown> } = req2('@neteasecloudmusicapienhanced/api/util/xeapiKey')
const { generateRandomChineseIP }: { generateRandomChineseIP: () => string } = req2('@neteasecloudmusicapienhanced/api/util/index')

export interface Track {
  id: number
  name: string
  artists: string
  album: string
  durationMs: number
  fee?: number
  mvId?: number
}

export interface PlaylistSummary extends Record<string, unknown> {
  id: number
  name: string
  trackCount: number
}

export interface ResolvedTrack {
  id: number
  kind: 'full' | 'trial' | 'none'
  identity: string
  injected?: boolean
  url: string | null
  br: number
  size: number
  type: string | null
  level: string | null
  fee?: number
  freeTrialInfo: Record<string, unknown> | null
  expiresAt: number
  cached: boolean
  name?: string
  artists?: string
}

export class NotLoggedInError extends Error {
  code = 'NOT_LOGGED_IN'
  constructor(message = '未登录：请先打开 /login 用网易云 App 扫码') {
    super(message)
  }
}

const TMP = os.tmpdir()
// 包内部把这些文件放在系统临时目录；我们额外镜像到项目内，保证重启后不必重新注册。
const MIRRORED_FILES = ['anonymous_token', 'xeapi_public_key']

@Injectable()
export class NeteaseService {
  private urlCache = new Map<number, ResolvedTrack & { identity: string }>()
  private initPromise: Promise<void> | null = null
  private injectedUnplayable = 0
  private injectedResolveErrors = 0
  private libraries = new Map<string, { at: number; tracks: Track[] }>()

  /** 完整资料才能证明一首歌在歌单之外；部分读取只提供已知曲目。 */
  async selectionLibrary(): Promise<{ tracks: Track[]; complete: boolean; message?: string }> {
    const session = this.requireSession()
    const identity = this.currentIdentity()
    const previous = this.libraries.get(identity)
    if (previous && Date.now() - previous.at < 300_000) return { tracks: previous.tracks, complete: true }
    const known = new Map<number, Track>()
    let complete = true
    try {
      const ids = await this.getLikedIds(session.cookie)
      const tracks = await this.getLikedTracks(session.cookie, ids)
      tracks.forEach(t => known.set(t.id, t))
      if (tracks.length !== ids.length) complete = false
    } catch (_) { complete = false }
    try {
      const uid = identifier(session.profile?.userId ?? (await this.whoami())?.userId)
      const playlists = await this.getUserPlaylists(session.cookie, uid)
      if (!playlists.complete) complete = false
      for (const pl of [...playlists.created, ...playlists.collected]) {
        try {
          const result = await this.getPlaylistTracks(session.cookie, Number(pl.id))
          result.tracks.forEach(t => known.set(t.id, t))
          if (result.returned !== result.trackCount) complete = false
        } catch (_) { complete = false }
      }
    } catch (_) { complete = false }
    if (this.currentIdentity() !== identity) throw new Error('账号已经切换，请重新准备')
    if (complete) {
      const tracks = [...known.values()]
      this.libraries.set(identity, {at: Date.now(), tracks})
      return {tracks, complete: true}
    }
    previous?.tracks.forEach(t => { if (!known.has(t.id)) known.set(t.id, t) })
    return { tracks: [...known.values()], complete: false, message: previous ? '歌单资料暂未更新，暂缓探索，使用上次已知记录及已确认歌曲' : '歌单资料未读完整，暂缓探索，先播放已确认歌曲' }
  }

  async discoveryCandidates(seedIds: number[]): Promise<{ tracks: Track[]; message?: string }> {
    const {cookie} = this.requireSession()
    const results = await Promise.allSettled([
      api.recommend_songs({cookie, timeout: 15000}).then(r => parseTracks(record(body(r).data, '推荐数据').dailySongs)),
      ...seedIds.slice(0, 4).map(id => api.simi_song({id, cookie, timeout: 15000}).then(r => parseTracks(body(r).songs))),
    ])
    const tracks = new Map<number, Track>()
    for (const result of results) if (result.status === 'fulfilled') for (const t of result.value) {
      if (Number.isSafeInteger(t.id) && t.id > 0) tracks.set(t.id, t)
    }
    return {tracks: [...tracks.values()], message: results.some(r => r.status === 'rejected') ? '部分探索来源不可用，使用已取得的候选' : undefined}
  }

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.mkdirSync(NCM_TMP_DIR, { recursive: true })
  }

  private mirrorToTmp(): void {
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

  private mirrorFromTmp(): void {
    for (const name of MIRRORED_FILES) {
      const src = path.join(TMP, name)
      const dst = path.join(NCM_TMP_DIR, name)
      try {
        const content = fs.readFileSync(src, 'utf-8')
        if (content.trim()) fs.writeFileSync(dst, content, 'utf-8')
      } catch (_) {}
    }
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      this.mirrorToTmp()
      const g = globalThis as Record<string, unknown>
      g.cnIp = g.cnIp || generateRandomChineseIP()
      let current: Record<string, unknown> = {}
      try {
        current = record(JSON.parse(fs.readFileSync(path.join(TMP, 'xeapi_public_key'), 'utf-8')), '公钥配置')
      } catch (_) {}
      if (!current.sk) {
        const key = await getXeapiPublicKey(current, g.deviceId || '')
        fs.writeFileSync(path.join(TMP, 'xeapi_public_key'), JSON.stringify(key), 'utf-8')
      }
      // 注册匿名 token（游客态），用于未登录时的辅助查询
      await generateConfig()
      this.mirrorFromTmp()
    })().catch((err) => {
      this.initPromise = null
      throw err
    })
    return this.initPromise
  }

  /* ---------- 会话（登录 cookie） ---------- */

  loadSession(): { cookie: string; savedAt: string; profile: Record<string, unknown> | null } | null {
    try {
      const raw = record(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')), '登录态')
      if (raw && typeof raw.cookie === 'string' && raw.cookie.includes('MUSIC_U')) {
        const profile = raw.profile == null ? null : record(raw.profile, '账号')
        if (profile) identifier(profile.userId)
        return { cookie: raw.cookie, savedAt: text(raw.savedAt, 'savedAt'), profile }
      }
    } catch (_) {}
    return null
  }

  saveSession(cookie: string, profile: Record<string, unknown> | null): { cookie: string; savedAt: string; profile: Record<string, unknown> | null } {
    const data = { cookie, savedAt: new Date().toISOString(), profile: profile || null }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8')
    fs.chmodSync(SESSION_FILE, 0o600)
    this.clearUrlCache()
    return data
  }

  clearSession(): void {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE)
    this.clearUrlCache()
  }

  requireSession(): { cookie: string; savedAt: string; profile: Record<string, unknown> | null } {
    const session = this.loadSession()
    if (!session) {
      throw new NotLoggedInError()
    }
    return session
  }

  /* ---------- 登录 ---------- */

  async qrCreate(): Promise<Record<string, unknown>> {
    await this.init()
    const keyData = record(body(await api.login_qr_key({})).data, '二维码数据')
    const key = text(keyData.unikey, '二维码 key')
    if (!key) throw new Error('未能取得二维码 key')
    const data = record(body(await api.login_qr_create({ key, qrimg: true, platform: 'web' })).data, '二维码数据')
    return { key, qrimg: text(data.qrimg, '二维码图片'), qrurl: text(data.qrurl, '二维码链接') }
  }

  async qrCheck(key: string): Promise<{ code: number; message: string; account?: Record<string, unknown> | null }> {
    await this.init()
    const response = record(await api.login_qr_check({ key }))
    const data = body(response, false)
    const code = integer(data.code, '登录状态')
    const message = data.message === undefined ? '' : text(data.message, '登录消息')
    if (code !== 803) return { code, message }
    const cookie = data.cookie === undefined
      ? list(response.cookie, '登录 cookie').map(value => text(value, 'cookie')).join(';')
      : text(data.cookie, '登录 cookie')
    if (!cookie.includes('MUSIC_U')) throw new Error('登录 cookie 无效')
    const account = body(await api.user_account({ cookie }))
    const profile = account.profile == null ? null : record(account.profile, '账号')
    if (profile) identifier(profile.userId)
    this.saveSession(cookie, profile)
    return { code, message, account: await this.whoami() }
  }

  async whoami(): Promise<{ userId: number; nickname: string; vipType: number; savedAt: string } | null> {
    const session = this.loadSession()
    if (!session) return null
    try {
      const response = record(await api.login_status({ cookie: session.cookie }))
      const data = record(record(response.body, '登录状态').data, '账号数据')
      if (integer(data.code, '登录状态码') !== 200) return null
      const profile = record(data.profile, '账号')
      return {
        userId: identifier(profile.userId), nickname: text(profile.nickname, '昵称'),
        vipType: integer(profile.vipType, 'vipType'), savedAt: session.savedAt,
      }
    } catch (_) { return null }
  }

  /* ---------- 音乐资料（只读） ---------- */

  /** 红心歌曲：likelist 一次返回全部 id，无分页。 */
  async getLikedIds(cookie: string): Promise<number[]> {
    const data = body(await api.likelist({ uid: 0, cookie, timeout: 15000 }))
    return [...new Set(list(data.ids, '红心歌曲列表').map(identifier))]
  }

  /**
   * 收藏 + 自建歌单。
   *
   * 实测发现 `/api/user/playlist` 的行为与文档直觉不同（2026-09-14，本账号 6 个歌单）：
   *  - `limit` 被服务端忽略，返回从 offset 到末尾的全部歌单；
   *  - `offset` 正常生效；
   *  - `more` 恒为 false，不能用来判断是否还有下一页。
   * 因此按「实际返回条数」推进 offset，并靠去重保证不会重复，而不是靠 more/limit。
   */
  async getUserPlaylists(cookie: string, uid: number, { pageSize = 50, maxPages = 40 } = {}): Promise<{
    collected: PlaylistSummary[]
    created: PlaylistSummary[]
    pages: Record<string, unknown>[]
    total: number
    complete: boolean
  }> {
    identifier(uid)
    const collected: PlaylistSummary[] = []
    const created: PlaylistSummary[] = []
    const seen = new Set<string>()
    const log: Record<string, unknown>[] = []
    let offset = 0
    let pages = 0
    let complete = false

    while (pages < maxPages) {
      const data = body(await api.user_playlist({ uid, limit: pageSize, offset, cookie, timeout: 15000 }))
      const playlists = list(data.playlist, '歌单列表').map(parsePlaylist)
      if (typeof data.more !== 'boolean') throw new Error('歌单分页标记无效')
      let added = 0
      for (const pl of playlists) {
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
          creator: pl.creator && (pl.creator as Record<string, unknown>).nickname,
          privacy: pl.privacy,
        }
        if (pl.subscribed || pl.userId !== uid) collected.push(item)
        else created.push(item)
      }
      log.push({ offset, returned: playlists.length, added, more: data.more })
      pages += 1

      if (playlists.length === 0) { complete = data.more !== true; break }
      if (added === 0) break
      if (data.more !== true && playlists.length < pageSize) { complete = true; break }
      offset += playlists.length
    }

    return { collected, created, pages: log, total: collected.length + created.length, complete }
  }

  /**
   * 取歌单内歌曲。优先用 playlist_detail 的完整 trackIds（不截断），再分块取歌曲详情。
   * 如果 trackIds 明显少于 trackCount，退回 playlist_track_all 的 offset 分页。
   */
  async getPlaylistTracks(cookie: string, playlistId: string | number, { chunk = 300 } = {}): Promise<{
    via: string
    trackCount: number
    returned: number
    tracks: Track[]
  }> {
    const detail = body(await api.playlist_detail({ id: playlistId, cookie, timeout: 15000 }))
    const pl = record(detail.playlist, '歌单详情')
    const trackCount = integer(pl.trackCount, '完整曲目数')
    const trackIds = list(pl.trackIds, '歌单曲目').map(value => identifier(record(value, '歌曲').id))
    let ids = trackIds
    let via = 'playlist_detail.trackIds'
    if (!ids.length || (trackCount && ids.length < trackCount)) {
      via = 'playlist_track_all'
      ids = []
      let offset = 0
      while (offset < (trackCount || 0) + 1) {
        const data = body(await api.playlist_track_all({ id: playlistId, limit: chunk, offset, cookie, timeout: 15000 }))
        const songs = parseTracks(data.songs)
        if (!songs.length) break
        ids.push(...songs.map(song => song.id))
        offset += chunk
        if (songs.length < chunk) break
      }
    }

    const unique = [...new Set(ids)]
    const tracks: Track[] = []
    for (let i = 0; i < unique.length; i += chunk) {
      const slice = unique.slice(i, i + chunk)
      const data = body(await api.song_detail({ ids: slice.join(','), cookie, timeout: 15000 }))
      const byId = new Map(parseTracks(data.songs).map(song => [song.id, song]))
      for (const id of slice) {
        const s = byId.get(id)
        if (s) tracks.push(s)
      }
    }
    return { via, trackCount: trackCount, returned: tracks.length, tracks }
  }

  /** 红心 id 批量取歌曲详情（song_detail 单次上限 1000，按 300 分块）。 */
  async getLikedTracks(cookie: string, ids: number[], { chunk = 300 } = {}): Promise<Track[]> {
    const tracks: Track[] = []
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk)
      const data = body(await api.song_detail({ ids: slice.join(','), cookie, timeout: 15000 }))
      const byId = new Map(parseTracks(data.songs).map(song => [song.id, song]))
      for (const id of slice) {
        const s = byId.get(id)
        if (s) tracks.push(s)
      }
    }
    return tracks
  }

  /* ---------- 音源（不写回、无播放副作用） ---------- */

  /**
   * 缓存必须绑定「是谁在听」：退出登录或换账号后不能复用上一个人的播放地址。
   * 用 cookie 的截断哈希做身份标识，不保存也不外泄明文凭据。
   */
  currentIdentity(): string {
    const session = this.loadSession()
    if (!session) return 'anon'
    return 'user:' + crypto.createHash('sha256').update(session.cookie).digest('hex').slice(0, 12)
  }

  clearUrlCache(): void {
    this.urlCache.clear()
  }

  // 测试专用：模拟「刷新后确认该曲不可播放」，用于验证缓存失效路径。
  setInjectedUnplayable(n: number): number {
    this.injectedUnplayable = Number(n) || 0
    return this.injectedUnplayable
  }

  // 测试专用：让接下来的 N 次音源查询直接报错，用于验证「音乐服务不可用」的降级与退避。
  setInjectedResolveErrors(n: number): number {
    this.injectedResolveErrors = Number(n) || 0
    return this.injectedResolveErrors
  }

  private cacheGet(id: number, identity: string): ResolvedTrack | null {
    const key = Number(id)
    const hit = this.urlCache.get(key)
    if (!hit) return null
    if (hit.identity !== identity) {
      // 身份不匹配（退出登录 / 换账号）：旧条目直接作废
      this.urlCache.delete(key)
      return null
    }
    if (hit.expiresAt - Date.now() < 60_000) {
      this.urlCache.delete(key)
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
  async resolveTrack(id: number | string, { force = false } = {}): Promise<ResolvedTrack> {
    const key = identifier(Number(id))
    if (process.env.RADIO_TEST_HOOKS === '1' && this.injectedResolveErrors > 0) {
      this.injectedResolveErrors -= 1
      const err = new Error('（测试注入）音源接口失败') as Error & { code: string }
      err.code = 'injected_resolve_error'
      throw err
    }
    // 先确定身份，再决定能不能命中缓存：
    // 正常情况下必须已登录；只有在开启测试注入时才允许游客态解析，
    // 用于在拿到本人资料前验证播放链路本身。游客态同样受网易权限限制。
    const session = this.loadSession()
    const cookie = session
      ? session.cookie
      : process.env.RADIO_TEST_HOOKS === '1'
        ? ''
        : this.requireSession().cookie
    const identity = this.currentIdentity()

    if (!force) {
      const cached = this.cacheGet(key, identity)
      if (cached) return { ...cached, cached: true }
    }

    const upstream = await this.sourceResponse(key, cookie)
    const info = parseSource(upstream, key, identity)
    // 地址有效则写入缓存；刷新后确认不可播放/无地址，必须把旧条目删掉，
    // 否则下一次普通查询又会命中已经不成立的旧地址。
    if (info.url) this.urlCache.set(key, info)
    else this.urlCache.delete(key)
    return info
  }
  /** Fault injection and real responses share the same downstream parser and cache policy. */
  private async sourceResponse(key: number, cookie: string): Promise<Record<string, unknown>> {
    if (process.env.RADIO_TEST_HOOKS === '1' && this.injectedUnplayable > 0) {
      this.injectedUnplayable -= 1
      return {
        injected: true,
        url: null,
        br: 0,
        size: 0,
        type: null,
        level: null,
        fee: -1,
        freeTrialInfo: null,
        expi: 0,
      }
    }
    const data = body(await api.song_url_v1({ id: key, level: 'exhigh', cookie, timeout: 15000 }))
    return record(list(data.data, '音源列表')[0], '音源')

  }

}
