/**
 * DJ 播报音频本地缓存（任务 03）：把已校验的 MP3 原子发布为可同源播放的成品。
 *
 * 缓存键 = sha256(模型 | 音色 | 影响声音的参数 | 完整文案)——音色变化绝不命中旧声音。
 * 约束（契约第 4 节）：
 *  - 默认 TTL 24 小时、活动目录上限 100 MiB；
 *  - 正在使用的成品（retain/release）受保护；腾不出空间时本次语音降级（cache_full），不无限扩容；
 *  - 淘汰一律移入废纸篓（moveToTrash，默认 ~/.Trash，不可用时退回 <dir>/.trash），
 *    绝不自动清空废纸篓，也绝不删除缓存目录之外的任何文件；
 *  - 发布是原子的：先写临时文件再 rename，并发同键不会留下半成品。
 */
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
const ASSET_ID_RE = /^[a-f0-9]{64}$/

/** 项目内默认缓存目录（可用环境变量 DJ_AUDIO_CACHE_DIR 覆盖）。 */
function defaultCacheDir() {
  return process.env.DJ_AUDIO_CACHE_DIR || path.resolve(__dirname, '..', 'data', 'dj-audio')
}

function defaultMoveToTrash(src, dir) {
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

function createAudioCache(opts = {}) {
  const dir = opts.dir
  if (!dir) throw new TypeError('createAudioCache: 必须提供缓存目录')
  fs.mkdirSync(dir, { recursive: true })
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES
  const moveToTrash = opts.moveToTrash || ((src) => defaultMoveToTrash(src, dir))
  const retained = new Map() // assetId -> 引用计数

  const mp3Path = (assetId) => path.join(dir, `${assetId}.mp3`)
  const metaPath = (assetId) => path.join(dir, `${assetId}.json`)

  function computeAssetId({ text, model, referenceId, voiceParams }) {
    const h = crypto.createHash('sha256')
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
  function listEntries() {
    const ids = new Set()
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch (_) {
      return []
    }
    for (const f of entries) {
      const m = f.match(/^([a-f0-9]{64})\.(mp3|json)$/)
      if (m) ids.add(m[1])
    }
    return [...ids].map((assetId) => {
      const meta = readMeta(assetId)
      if (!meta) return { assetId, corrupt: true, bytes: fileSize(mp3Path(assetId)), createdAt: 0 }
      return { assetId, corrupt: false, bytes: meta.bytes || fileSize(mp3Path(assetId)), createdAt: meta.createdAt || 0 }
    })
  }

  function fileSize(p) {
    try {
      return fs.statSync(p).size
    } catch (_) {
      return 0
    }
  }

  function readMeta(assetId) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(assetId), 'utf-8'))
      if (!meta || meta.assetId !== assetId) return null
      return meta
    } catch (_) {
      return null
    }
  }

  async function trashFile(p) {
    const r = await moveToTrash(p, dir)
    if (!(r && r.ok)) return false
    // 防御：废纸篓声称成功但文件还在（实现异常）时按失败处理，宁可保留也不误报已释放
    if (fs.existsSync(p)) return false
    return true
  }

  async function removeEntry(assetId) {
    let ok = true
    for (const p of [mp3Path(assetId), metaPath(assetId)]) {
      if (fs.existsSync(p)) ok = (await trashFile(p)) && ok
    }
    if (ok) retained.delete(assetId)
    return ok
  }

  /** 淘汰过期与超容量条目；retained 的条目跳过。返回释放的字节数。 */
  async function prune({ now = Date.now(), freeBytes = 0 } = {}) {
    let freed = 0
    const entries = listEntries().filter((e) => !retained.has(e.assetId))
    for (const e of entries) {
      const expired = e.corrupt || !e.createdAt || now - e.createdAt > ttlMs
      if (expired && (await removeEntry(e.assetId))) freed += e.bytes
    }
    const remaining = () =>
      listEntries().reduce((sum, e) => sum + (e.bytes || 0), 0)
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
      oldestAt: entries.reduce((m, e) => (e.createdAt && (!m || e.createdAt < m) ? e.createdAt : m), null),
      maxBytes,
      ttlMs,
    }
  }

  /**
   * 发布成品：缓冲区必须已通过有效性校验（有效 MP3 + 时长）。
   * 返回 { ok:true, assetId, path, bytes, durationMs, reused }
   * 或   { ok:false, code:'invalid_audio'|'cache_full', message }
   */
  async function put(input = {}) {
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
      if (meta) return { ok: true, assetId, path: mp3Path(assetId), bytes: meta.bytes || buffer.length, durationMs: meta.durationMs, reused: true }
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
      return { ok: false, code: 'error', message: '缓存写入失败：' + String((err && err.message) || err) }
    }
    return { ok: true, assetId, path: mp3Path(assetId), bytes: buffer.length, durationMs, reused: false }
  }

  /** 读取元信息；损坏缓存返回 { hit:false, corrupt:true }。 */
  function getMeta(assetId) {
    if (!ASSET_ID_RE.test(String(assetId || ''))) return { hit: false, corrupt: false }
    if (!fs.existsSync(mp3Path(assetId))) return { hit: false, corrupt: false }
    const meta = readMeta(assetId)
    if (!meta) return { hit: false, corrupt: true }
    return { hit: true, corrupt: false, ...meta }
  }

  /** 只为本缓存内的资产解析路径；拒绝路径穿越与外部文件。 */
  function pathFor(assetId) {
    const id = String(assetId || '')
    if (!ASSET_ID_RE.test(id)) return null
    const p = mp3Path(id)
    if (!fs.existsSync(p)) return null
    return p
  }

  function retain(assetId) {
    retained.set(assetId, (retained.get(assetId) || 0) + 1)
  }
  function release(assetId) {
    const n = (retained.get(assetId) || 0) - 1
    if (n <= 0) retained.delete(assetId)
    else retained.set(assetId, n)
  }
  function isRetained(assetId) {
    return retained.has(assetId)
  }

  return { put, getMeta, pathFor, prune, stats, retain, release, isRetained, computeAssetId }
}

module.exports = { createAudioCache, defaultCacheDir, DEFAULT_TTL_MS, DEFAULT_MAX_BYTES }
