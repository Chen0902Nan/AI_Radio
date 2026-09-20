import type { ResolvedTrack, Track } from './netease.service'

export function record(value: unknown, field = '响应'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}无效：应为对象`)
  return value as Record<string, unknown>
}
export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}无效：应为数组`)
  return value
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field}无效：应为字符串`)
  return value
}
export function finite(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`${field}无效：应为有限数字`)
  return value
}
export function integer(value: unknown, field: string, minimum = 0): number {
  const result = finite(value, field, minimum)
  if (!Number.isSafeInteger(result)) throw new Error(`${field}无效：应为安全整数`)
  return result
}
export const identifier = (value: unknown): number => integer(value, 'id', 1)
export function body(value: unknown, success = true): Record<string, unknown> {
  const result = record(record(value).body, '响应正文')
  const code = integer(result.code, 'code')
  if (success && code !== 200) throw new Error(`网易云接口失败 code=${code}`)
  return result
}
export function normalizeTrack(value: unknown): Track {
  const song = record(value, '歌曲')
  const artists = list(song.ar ?? song.artists, '歌手列表')
  const album = record(song.al ?? song.album, '专辑')
  return {
    id: identifier(song.id), name: text(song.name, '歌名'),
    artists: artists.map(artist => text(record(artist, '歌手').name, '歌手名')).join(' / '),
    album: text(album.name, '专辑名'), durationMs: finite(song.dt ?? song.duration, '歌曲时长'),
    fee: song.fee === undefined ? undefined : finite(song.fee, 'fee', -1),
    mvId: song.mv === undefined ? 0 : integer(song.mv, 'mvId'),
  }
}
export function tracks(value: unknown): Track[] { return list(value, '歌曲列表').map(normalizeTrack) }
export function playlist(value: unknown): Record<string, unknown> & { id: number; userId: number; name: string; trackCount: number } {
  const item = record(value, '歌单')
  if (item.subscribed !== undefined && typeof item.subscribed !== 'boolean') throw new Error('subscribed无效')
  if (item.creator !== undefined) text(record(item.creator, '歌单作者').nickname, '歌单作者名')
  if (item.playCount !== undefined) finite(item.playCount, 'playCount')
  return { ...item, id: identifier(item.id), userId: identifier(item.userId), name: text(item.name, '歌单名'), trackCount: integer(item.trackCount, 'trackCount') }
}
function sourceUrl(value: unknown): string | null {
  if (value === null || value === '') return null
  const url = text(value, '音源 URL')
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url
  } catch (_) { /* Report the same boundary error for malformed and unsupported URLs. */ }
  throw new Error('音源 URL 无效：必须为 HTTP(S) 地址')
}
function optionalNumber(value: unknown, field: string, fallback = 0): number {
  return value === undefined ? fallback : finite(value, field)
}
function optionalText(value: unknown, field: string): string | null { return value == null ? null : text(value, field) }
function classifySource(url: string | null, trial: Record<string, unknown> | null): ResolvedTrack['kind'] {
  if (!url) return 'none'
  return trial ? 'trial' : 'full'
}
export function source(value: unknown, id: number, identity: string): ResolvedTrack {
  const item = record(value, '音源')
  const url = sourceUrl(item.url)
  const trial = item.freeTrialInfo == null ? null : record(item.freeTrialInfo, '试听信息')
  const expi = optionalNumber(item.expi, '到期时间', 1200)
  const expiresAt = Date.now() + Math.max(0, expi - 30) * 1000
  if (!Number.isFinite(expiresAt)) throw new Error('到期时间无效')
  const freeTrialInfo = trial && Object.keys(trial).length ? trial : null
  return {
    id, identity, kind: classifySource(url, freeTrialInfo), url,
    injected: Boolean(item.injected), freeTrialInfo, expiresAt, cached: false,
    br: optionalNumber(item.br, 'br'),
    size: item.size === undefined ? 0 : integer(item.size, 'size'),
    type: optionalText(item.type, 'type'),
    level: optionalText(item.level, 'level'),
    fee: item.fee === undefined ? undefined : finite(item.fee, 'fee', -1),
  }
}
