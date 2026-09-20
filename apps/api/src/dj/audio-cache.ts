/**
 * DJ 播报音频本地缓存（迁移自 server/dj-audio-cache.js）。
 *
 * 缓存键 = sha256(模型 | 音色 | 影响声音的参数 | 完整文案)——音色变化绝不命中旧声音。
 * 约束：
 *  - 默认 TTL 24 小时、活动目录上限 100 MiB；
 *  - 正在使用的成品（retain/release）受保护；腾不出空间时本次语音降级（cache_full）；
 *  - 淘汰一律移入废纸篓（moveToTrash，默认 ~/.Trash，不可用时退回 <dir>/.trash），
 *    绝不自动清空废纸篓，也绝不删除缓存目录之外的任何文件；
 *  - 发布是原子的：先写临时文件再 rename，并发同键不会留下半成品。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DJ_AUDIO_CACHE_DIR } from '../config/app-config'

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const ASSET_ID_RE = /^[a-f0-9]{64}$/

interface CacheMetadata extends Record<string, unknown> {
  assetId: string
  bytes: number
  durationMs: number
  createdAt: number
  contentType: string
}

function finiteAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
}

function parseMetadata(value: unknown, assetId: string, actualBytes: number): CacheMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const meta = value as Record<string, unknown>
  if (meta.assetId !== assetId || 'hit' in meta || 'corrupt' in meta) return null
  const { bytes, durationMs, createdAt, contentType } = meta
  if (!finiteAtLeast(bytes, 1) || !Number.isSafeInteger(bytes) || bytes !== actualBytes) return null
  if (!finiteAtLeast(durationMs, Number.MIN_VALUE) || !finiteAtLeast(createdAt, 0)) return null
  if (typeof contentType !== 'string' || !/^audio\/[^\s;]+(?:\s*;.*)?$/i.test(contentType)) return null
  return { ...meta, assetId, bytes, durationMs, createdAt, contentType }
}

export function defaultMoveToTrash(src: string, dir: string): { ok: boolean; dest?: string } {
  const candidates = [path.join(os.homedir(), '.Trash'), path.join(dir, '.trash')]
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const dest = path.join(base, `${path.basename(src)}.${Date.now()}.trash`)
      fs.renameSync(src, dest)
      return { ok: true, dest }
    } catch (_) {}
  }
  return { ok: false }
}

export interface AudioCache {
  put(input: {
    text: string
    model: string
    referenceId?: string | null
    voiceParams?: Record<string, unknown>
    buffer: Buffer
    durationMs: number
    contentType?: string
    now?: number
  }): Promise<{ ok: boolean; code?: string; message?: string; assetId?: string; path?: string; bytes?: number; durationMs?: number; reused?: boolean }>
  getMeta(assetId: string): Record<string, unknown> & { hit: boolean; corrupt: boolean }
  pathFor(assetId: string): string | null
  prune(opts?: { now?: number; freeBytes?: number }): Promise<number>
  stats(): { files: number; bytes: number; oldestAt: number | null; maxBytes: number; ttlMs: number }
  retain(assetId: string): void
  release(assetId: string): void
  isRetained(assetId: string): boolean
  computeAssetId(input: { text: string; model: string; referenceId?: string | null; voiceParams?: Record<string, unknown> }): string
}

export function createAudioCache(opts: { dir: string; ttlMs?: number; maxBytes?: number; moveToTrash?: (src: string, dir: string) => Promise<{ ok: boolean; dest?: string }> | { ok: boolean; dest?: string } }): AudioCache {
  const dir = opts.dir
  if (!dir) throw new TypeError('createAudioCache: 必须提供缓存目录')
  fs.mkdirSync(dir, { recursive: true })
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES
  const moveToTrash = opts.moveToTrash || ((src: string) => defaultMoveToTrash(src, dir))
  const retained = new Map<string, number>() // assetId -> 引用计数

  const mp3Path = (assetId: string) => path.join(dir, `${assetId}.mp3`)
  const metaPath = (assetId: string) => path.join(dir, `${assetId}.json`)

  function computeAssetId({ text, model, referenceId, voiceParams }: { text: string; model: string; referenceId?: string | null; voiceParams?: Record<string, unknown> }): string {
    const h = createHash('sha256')
    h.update(String(model))
    h.update('\u0000')
    h.update(String(referenceId))
    h.update('\u0000')
    h.update(JSON.stringify(voiceParams || {}))
    h.update('\u0000')
    h.update(String(text)) // 完整文案，不截断
    return h.digest('hex')
  }

  /** 目录内全部缓存条目（只看 64 位十六进制资产名，其他文件不碰）。 */
  function listEntries(): Array<{ assetId: string; corrupt: boolean; bytes: number; createdAt: number }> {
    const ids = new Set<string>()
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch (_) {
      return []
    }
    for (const f of entries) {
      const m = f.match(/^([a-f0-9]{64})\.(mp3|json)$/)
      if (m) ids.add(m[1]!)
    }
    return [...ids].map((assetId) => {
      const meta = readMeta(assetId)
      if (!meta) return { assetId, corrupt: true, bytes: fileSize(mp3Path(assetId)), createdAt: 0 }
      return { assetId, corrupt: false, bytes: meta.bytes, createdAt: meta.createdAt }
    })
  }

  function fileSize(p: string): number {
    try {
      return fs.statSync(p).size
    } catch (_) {
      return 0
    }
  }

  function readMeta(assetId: string): CacheMetadata | null {
    try {
      const meta: unknown = JSON.parse(fs.readFileSync(metaPath(assetId), 'utf-8'))
      return parseMetadata(meta, assetId, fileSize(mp3Path(assetId)))
    } catch (_) {
      return null
    }
  }

  async function trashFile(p: string): Promise<boolean> {
    const r = await moveToTrash(p, dir)
    if (!(r && r.ok)) return false
    // 防御：废纸篓声称成功但文件还在（实现异常）时按失败处理，宁可保留也不误报已释放
    if (fs.existsSync(p)) return false
    return true
  }

  async function removeEntry(assetId: string): Promise<boolean> {
    let ok = true
    for (const p of [mp3Path(assetId), metaPath(assetId)]) {
      if (fs.existsSync(p)) ok = (await trashFile(p)) && ok
    }
    if (ok) retained.delete(assetId)
    return ok
  }

  /** 淘汰过期与超容量条目；retained 的条目跳过。返回释放的字节数。 */
  async function prune({ now = Date.now(), freeBytes = 0 } = {}): Promise<number> {
    let freed = 0
    const entries = listEntries().filter((e) => !retained.has(e.assetId))
    for (const e of entries) {
      const expired = e.corrupt || !e.createdAt || now - e.createdAt > ttlMs
      if (expired && (await removeEntry(e.assetId))) freed += e.bytes
    }
    const remaining = () => listEntries().reduce((sum, e) => sum + (e.bytes || 0), 0)
    for (;;) {
      const usage = remaining()
      if (usage <= maxBytes - freeBytes) break
      const victim = listEntries()
        .filter((e) => !retained.has(e.assetId))
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!victim) break // 只剩使用中的成品：腾不出，调用方按降级处理
      if (!(await removeEntry(victim.assetId))) break
      freed += victim.bytes
    }
    return freed
  }

  function stats() {
    const entries = listEntries()
    return {
      files: entries.length,
      bytes: entries.reduce((s, e) => s + (e.bytes || 0), 0),
      oldestAt: entries.reduce<number | null>((m, e) => (e.createdAt && (!m || e.createdAt < m) ? e.createdAt : m), null),
      maxBytes,
      ttlMs,
    }
  }

  /** 发布成品：缓冲区必须已通过有效性校验（有效 MP3 + 时长）。 */
  async function put(input: {
    text: string
    model: string
    referenceId?: string | null
    voiceParams?: Record<string, unknown>
    buffer: Buffer
    durationMs: number
    contentType?: string
    now?: number
  }): Promise<{ ok: boolean; code?: string; message?: string; assetId?: string; path?: string; bytes?: number; durationMs?: number; reused?: boolean }> {
    const { text, model, referenceId } = input
    const buffer = input.buffer
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { ok: false, code: 'invalid_audio', message: '没有可发布的音频字节' }
    }
    const durationMs = Number(input.durationMs)
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return { ok: false, code: 'invalid_audio', message: '缺少有效音频时长' }
    }
    const assetId = computeAssetId({ text, model, referenceId, voiceParams: input.voiceParams })
    const now = Number(input.now) || Date.now()

    if (fs.existsSync(mp3Path(assetId))) {
      const meta = readMeta(assetId)
      if (meta) return { ok: true, assetId, path: mp3Path(assetId), bytes: meta.bytes, durationMs: meta.durationMs, reused: true }
      // meta 损坏：当作新发布覆盖
      await removeEntry(assetId)
    }

    await prune({ now, freeBytes: buffer.length })
    const usage = stats().bytes
    if (usage + buffer.length > maxBytes) {
      return { ok: false, code: 'cache_full', message: '缓存已达容量上限且无法腾出空间，本次语音降级' }
    }

    const tmp = path.join(dir, `.tmp-${assetId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const meta = {
      assetId,
      key: { model, referenceId, voiceParams: input.voiceParams || {} },
      textLength: String(text || '').length,
      durationMs,
      bytes: buffer.length,
      contentType: input.contentType || 'audio/mpeg',
      createdAt: now,
    }
    try {
      fs.writeFileSync(tmp, buffer)
      fs.renameSync(tmp, mp3Path(assetId)) // 原子发布
      fs.writeFileSync(`${tmp}.json`, JSON.stringify(meta))
      fs.renameSync(`${tmp}.json`, metaPath(assetId))
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        if (fs.existsSync(`${tmp}.json`)) fs.unlinkSync(`${tmp}.json`)
      } catch (_) {}
      return { ok: false, code: 'error', message: '缓存写入失败：' + String((err as Error).message || err) }
    }
    return { ok: true, assetId, path: mp3Path(assetId), bytes: buffer.length, durationMs, reused: false }
  }

  /** 读取元信息；损坏缓存返回 { hit:false, corrupt:true }。 */
  function getMeta(assetId: string): Record<string, unknown> & { hit: boolean; corrupt: boolean } {
    if (!ASSET_ID_RE.test(String(assetId || ''))) return { hit: false, corrupt: false }
    if (!fs.existsSync(mp3Path(assetId))) return { hit: false, corrupt: false }
    const meta = readMeta(assetId)
    if (!meta) return { hit: false, corrupt: true }
    return { ...meta, hit: true, corrupt: false }
  }

  /** 只为本缓存内的资产解析路径；拒绝路径穿越与外部文件。 */
  function pathFor(assetId: string): string | null {
    const id = String(assetId || '')
    if (!ASSET_ID_RE.test(id)) return null
    const p = mp3Path(id)
    if (!fs.existsSync(p)) return null
    return p
  }

  function retain(assetId: string): void {
    retained.set(assetId, (retained.get(assetId) || 0) + 1)
  }
  function release(assetId: string): void {
    const n = (retained.get(assetId) || 0) - 1
    if (n <= 0) retained.delete(assetId)
    else retained.set(assetId, n)
  }
  function isRetained(assetId: string): boolean {
    return retained.has(assetId)
  }

  return { put, getMeta, pathFor, prune, stats, retain, release, isRetained, computeAssetId }
}
