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

const req2 = createRequire(__filename)
const api = req2('@neteasecloudmusicapienhanced/api')
const generateConfig = req2('@neteasecloudmusicapienhanced/api/generateConfig')
const { getXeapiPublicKey } = req2('@neteasecloudmusicapienhanced/api/util/xeapiKey')
const { generateRandomChineseIP } = req2('@neteasecloudmusicapienhanced/api/util/index')

export interface Track {
  id: number
  name: string
  artists: string
  album: string
  durationMs: number
  fee?: number
  mvId?: number
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
      const uid = Number(session.profile?.userId || (await this.whoami())?.userId)
      if (!uid) throw new Error('无法确认账号')
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
    return { tracks: [...known.values()], complete: Boolean(previous), message: previous ? '歌单资料暂未更新，使用上次完整记录及已确认歌曲' : '歌单资料未读完整，暂缓探索，先播放已确认歌曲' }
  }

  async discoveryCandidates(seedIds: number[]): Promise<{ tracks: Track[]; message?: string }> {
    const {cookie} = this.requireSession()
    const results = await Promise.allSettled([
      api.recommend_songs({cookie, timeout: 15000}).then((r: any) => {
        if (r.body.code !== 200 || !Array.isArray(r.body.data?.dailySongs)) throw new Error('推荐歌曲不可用')
        return r.body.data.dailySongs.map(normalizeTrack) as Track[]
      }),
      ...seedIds.slice(0, 4).map(id => api.simi_song({id, cookie, timeout: 15000}).then((r: any) => {
        if (r.body.code !== 200 || !Array.isArray(r.body.songs)) throw new Error('相似歌曲不可用')
        return r.body.songs.map(normalizeTrack) as Track[]
      })),
    ])
    const tracks = new Map<number, Track>()
    for (const result of results) if (result.status === 'fulfilled') for (const t of result.value as Track[]) {
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
        current = JSON.parse(fs.readFileSync(path.join(TMP, 'xeapi_public_key'), 'utf-8'))
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
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
      if (raw && typeof raw.cookie === 'string' && raw.cookie.includes('MUSIC_U')) {
        return raw
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
    const keyRes = await api.login_qr_key({})
    const key = keyRes.body && keyRes.body.data && keyRes.body.data.unikey
    if (!key) throw new Error('未能取得二维码 key')
    const qrRes = await api.login_qr_create({ key, qrimg: true, platform: 'web' })
    return { key, ...qrRes.body.data }
  }

  async qrCheck(key: string): Promise<{ code: number; message: string; account?: Record<string, unknown> | null }> {
    await this.init()
    const res = await api.login_qr_check({ key })
    const body = res.body || {}
    const code = body.code
    if (code === 803) {
      const cookie = body.cookie || (res.cookie || []).join(';')
      const account = await api.user_account({ cookie })
      const profile = (account.body && account.body.profile) || null
      this.saveSession(cookie, profile)
      const me = await this.whoami()
      return { code, message: body.message || '', account: me }
    }
    return { code, message: body.message || '' }
  }

  async whoami(): Promise<{ userId: number; nickname: string; vipType: number; savedAt: string } | null> {
    const session = this.loadSession()
    if (!session) return null
    try {
      const res = await api.login_status({ cookie: session.cookie })
      const profile = res.body && res.body.data && res.body.data.profile as Record<string, unknown> | undefined
      if (!profile) return null
      return {
        userId: profile.userId as number,
        nickname: profile.nickname as string,
        vipType: profile.vipType as number,
        savedAt: session.savedAt,
      }
    } catch (_) {
      return null
    }
  }

  /* ---------- 音乐资料（只读） ---------- */

  /** 红心歌曲：likelist 一次返回全部 id，无分页。 */
  async getLikedIds(cookie: string): Promise<number[]> {
    const res = await api.likelist({ uid: 0, cookie, timeout: 15000 })
    if (res.body.code !== 200) {
      throw new Error(`likelist 失败 code=${res.body.code}`)
    }
    if (!Array.isArray(res.body.ids)) throw new Error('红心资料缺少歌曲列表')
    const ids: unknown[] = res.body.ids
    if (ids.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('红心歌曲标识无效')
    return [...new Set(ids.map(Number))]
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
    collected: Record<string, unknown>[]
    created: Record<string, unknown>[]
    pages: Record<string, unknown>[]
    total: number
    complete: boolean
  }> {
    const collected: Record<string, unknown>[] = []
    const created: Record<string, unknown>[] = []
    const seen = new Set<string>()
    const log: Record<string, unknown>[] = []
    let offset = 0
    let pages = 0
    let complete = false

    while (pages < maxPages) {
      const res = await api.user_playlist({ uid, limit: pageSize, offset, cookie, timeout: 15000 })
      if (res.body.code !== 200) {
        throw new Error(`user_playlist 失败 code=${res.body.code} offset=${offset}`)
      }
      if (!Array.isArray(res.body.playlist)) throw new Error('歌单资料缺少列表')
      const list: Record<string, unknown>[] = res.body.playlist
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
          creator: pl.creator && (pl.creator as Record<string, unknown>).nickname,
          privacy: pl.privacy,
        }
        if (pl.subscribed || pl.userId !== uid) collected.push(item)
        else created.push(item)
      }
      log.push({ offset, returned: list.length, added, more: res.body.more })
      pages += 1

      if (list.length === 0) { complete = res.body.more !== true; break }
      if (added === 0) break
      if (res.body.more !== true && list.length < pageSize) { complete = true; break }
      offset += list.length
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
    const detail = await api.playlist_detail({ id: playlistId, cookie, timeout: 15000 })
    if (detail.body.code !== 200) {
      throw new Error(`playlist_detail 失败 id=${playlistId} code=${detail.body.code}`)
    }
    const pl = detail.body.playlist
    if (!pl || !Number.isSafeInteger(pl.trackCount) || pl.trackCount < 0) throw new Error('歌单资料缺少完整曲目数')
    const trackIds = (pl.trackIds || []).map((t: { id: number }) => t.id)
    let ids = trackIds
    let via = 'playlist_detail.trackIds'
    if (!ids.length || (pl.trackCount && ids.length < pl.trackCount)) {
      via = 'playlist_track_all'
      ids = []
      let offset = 0
      while (offset < (pl.trackCount || 0) + 1) {
        const res = await api.playlist_track_all({ id: playlistId, limit: chunk, offset, cookie, timeout: 15000 })
        if (res.body?.code !== 200) throw new Error('歌单分页读取失败')
        const songs = (res.body && res.body.songs) || []
        if (!songs.length) break
        ids.push(...songs.map((s: { id: number }) => s.id))
        offset += chunk
        if (songs.length < chunk) break
      }
    }

    const unique = [...new Set(ids)]
    const tracks: Track[] = []
    for (let i = 0; i < unique.length; i += chunk) {
      const slice = unique.slice(i, i + chunk)
      const res = await api.song_detail({ ids: slice.join(','), cookie, timeout: 15000 })
      if (res.body.code !== 200) {
        throw new Error(`song_detail 失败 code=${res.body.code}`)
      }
      const byId = new Map<number, Record<string, unknown>>((res.body.songs || []).map((s: Record<string, unknown>) => [s.id as number, s]))
      for (const id of slice as number[]) {
        const s = byId.get(id)
        if (s) tracks.push(normalizeTrack(s))
      }
    }
    return { via, trackCount: pl.trackCount, returned: tracks.length, tracks }
  }

  /** 红心 id 批量取歌曲详情（song_detail 单次上限 1000，按 300 分块）。 */
  async getLikedTracks(cookie: string, ids: number[], { chunk = 300 } = {}): Promise<Track[]> {
    const tracks: Track[] = []
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk)
      const res = await api.song_detail({ ids: slice.join(','), cookie, timeout: 15000 })
      if (res.body.code !== 200) {
        throw new Error(`song_detail 失败 code=${res.body.code} offset=${i}`)
      }
      const byId = new Map<number, Record<string, unknown>>((res.body.songs || []).map((s: Record<string, unknown>) => [s.id as number, s]))
      for (const id of slice as number[]) {
        const s = byId.get(id)
        if (s) tracks.push(normalizeTrack(s))
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
    const key = Number(id)
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

    // 注入点只替换「上游返回了什么」，后面的分类与缓存处理必须和真实路径完全一致；
    // 否则测试就变成自己验证自己，测不出缓存失效这类下游缺陷。
    let upstream: Record<string, unknown>
    if (process.env.RADIO_TEST_HOOKS === '1' && this.injectedUnplayable > 0) {
      this.injectedUnplayable -= 1
      upstream = {
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
    } else {
      const res = await api.song_url_v1({ id: key, level: 'exhigh', cookie, timeout: 15000 })
      if (res.body.code !== 200) {
        throw new Error(`song_url_v1 失败 code=${res.body.code}`)
      }
      upstream = (res.body.data || [])[0] || {}
    }

    const trial = upstream.freeTrialInfo && Object.keys(upstream.freeTrialInfo).length > 0
    const kind = !upstream.url ? 'none' : trial ? 'trial' : 'full'
    const info: ResolvedTrack & { identity: string } = {
      id: key,
      kind: kind as ResolvedTrack['kind'],
      identity,
      injected: Boolean(upstream.injected),
      url: (upstream.url as string) || null,
      br: (upstream.br as number) || 0,
      size: (upstream.size as number) || 0,
      type: (upstream.type as string) || null,
      level: (upstream.level as string) || null,
      fee: upstream.fee as number | undefined,
      freeTrialInfo: trial ? (upstream.freeTrialInfo as Record<string, unknown>) : null,
      expiresAt: Date.now() + Math.max(0, ((upstream.expi as number) || 1200) - 30) * 1000,
      cached: false,
    }
    // 地址有效则写入缓存；刷新后确认不可播放/无地址，必须把旧条目删掉，
    // 否则下一次普通查询又会命中已经不成立的旧地址。
    if (info.url) this.urlCache.set(key, info)
    else this.urlCache.delete(key)
    return info
  }
}

function normalizeTrack(s: Record<string, unknown>): Track {
  const ar = (s.ar || s.artists || []) as Array<{ name: string }>
  const al = (s.al || s.album || {}) as { name?: string }
  return {
    id: s.id as number,
    name: s.name as string,
    artists: ar.map((a) => a.name).join(' / '),
    album: al.name || '',
    durationMs: (s.dt as number) || (s.duration as number) || 0,
    fee: s.fee as number,
    mvId: (s.mv as number) || 0,
  }
}
