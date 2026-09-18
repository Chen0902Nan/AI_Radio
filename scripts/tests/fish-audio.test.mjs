import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveToTrash } from '../lib/trash.mjs'

const require = createRequire(import.meta.url)
// 迁移后测试目标：apps/api/src/dj 的 TS 实现（原 server/fish.js 等）
const fish = require('../../apps/api/dist/dj/fish.service.js')
const mp3Duration = require('../../apps/api/dist/dj/mp3-duration.js')
const cacheMod = require('../../apps/api/dist/dj/audio-cache.js')

/* ---------- 合成 MP3 测试素材（MPEG1 Layer3, 128kbps, 44100Hz） ---------- */

const SAMPLE_RATE = 44100
const BITRATE = 128000
const FRAME_BYTES = Math.floor((144 * BITRATE) / SAMPLE_RATE) // 417

function frameHeader() {
  return Buffer.from([0xff, 0xfb, 0x90, 0x00])
}
function buildCbrMp3(frames) {
  const parts = []
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(FRAME_BYTES)
    frameHeader().copy(f, 0)
    parts.push(f)
  }
  return Buffer.concat(parts)
}
function buildXingMp3(frames) {
  // MPEG1 mono 侧信息 17 字节；Xing 头：'Xing' + flags(frames+bytes) + frames + bytes
  const f = Buffer.alloc(FRAME_BYTES)
  frameHeader().copy(f, 0)
  f[3] = 0xc0 // channel mode = mono
  const tag = Buffer.alloc(8 + 8)
  tag.write('Xing', 0, 'latin1')
  tag.writeUInt32BE(0x03, 4) // frames + bytes
  tag.writeUInt32BE(frames, 8)
  tag.writeUInt32BE(frames * FRAME_BYTES, 12)
  tag.copy(f, 4 + 17)
  const rest = []
  for (let i = 1; i < frames; i++) {
    const g = Buffer.alloc(FRAME_BYTES)
    frameHeader().copy(g, 0)
    g[3] = 0xc0
    rest.push(g)
  }
  return Buffer.concat([f, ...rest])
}

/* ---------- MP3 时长解析 ---------- */

test('CBR MPEG1 Layer3 时长可解析', () => {
  const buf = buildCbrMp3(100)
  const secs = mp3Duration.mp3Duration(buf)
  const expect = (100 * 1152) / SAMPLE_RATE
  assert.ok(Math.abs(secs - expect) < 0.05, `得到 ${secs}，期望约 ${expect}`)
})

test('Xing VBR 头按帧数计算时长', () => {
  const secs = mp3Duration.mp3Duration(buildXingMp3(100))
  const expect = (100 * 1152) / SAMPLE_RATE
  assert.ok(Math.abs(secs - expect) < 0.001, `得到 ${secs}，期望 ${expect}`)
})

/* MPEG2/MPEG2.5 Layer3（LSF）：比特率表与 MPEG1 不同，错用 MPEG1 表会把时长算小 */
function lsfFrameHeader(version, bitrateIdx, sampleIdx) {
  // byte1: sync 111 | version(2) | layer III 01 | 无 CRC 1；byte2: 比特率索引 | 采样率索引
  return Buffer.from([0xff, 0xe0 | (version << 3) | 0x02 | 0x01, (bitrateIdx << 4) | (sampleIdx << 2), 0xc0])
}
function buildLsfCbrMp3(version, bitrateIdx, sampleRate, frames) {
  const bitrate = LSF_L3_BITRATES[bitrateIdx] * 1000
  const frameBytes = Math.floor((72 * bitrate) / sampleRate) // 576 采样/帧 → 系数 72
  const parts = []
  for (let i = 0; i < frames; i++) {
    const f = Buffer.alloc(frameBytes)
    lsfFrameHeader(version, bitrateIdx, 0).copy(f, 0)
    parts.push(f)
  }
  return Buffer.concat(parts)
}
const LSF_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

test('MPEG2 Layer3 时长按 LSF 比特率表计算，不会算小到绕过 30 秒限制', () => {
  const frames = 1400
  const secs = mp3Duration.mp3Duration(buildLsfCbrMp3(2, 12, 22050, frames)) // 128kbps / 22050Hz
  const expect = (frames * 576) / 22050 // 约 36.6 秒
  assert.ok(Math.abs(secs - expect) < 0.1, `得到 ${secs}，期望约 ${expect}`)
  assert.ok(secs > 30, '真实时长超过 30 秒的音频不能被算成 30 秒以内')
})

test('MPEG2.5 Layer3 使用同一张 LSF 比特率表', () => {
  const frames = 1200
  const secs = mp3Duration.mp3Duration(buildLsfCbrMp3(0, 8, 11025, frames)) // 64kbps / 11025Hz
  const expect = (frames * 576) / 11025 // 约 62.7 秒
  assert.ok(Math.abs(secs - expect) < 0.2, `得到 ${secs}，期望约 ${expect}`)
})

test('ID3v2 头被跳过后仍可解析；垃圾数据返回 null', () => {
  const tag = Buffer.alloc(10 + 100)
  tag.write('ID3', 0, 'latin1')
  tag[6] = 0; tag[7] = 0; tag[8] = 0; tag[9] = 100 // size = 100（syncsafe）
  const buf = Buffer.concat([tag, buildCbrMp3(50)])
  const secs = mp3Duration.mp3Duration(buf)
  assert.ok(Math.abs(secs - (50 * 1152) / SAMPLE_RATE) < 0.05)
  assert.equal(mp3Duration.mp3Duration(Buffer.from('<html>404</html>')), null)
  assert.equal(mp3Duration.mp3Duration(Buffer.alloc(0)), null)
})

/* ---------- Fish 适配层 ---------- */

const CFG = { apiKey: 'test-key', referenceId: 'voice-001', model: 's2.1-pro-free' }
const TEXT = '接下来是《灯塔》，晚安。'

function jsonResponse(status, body, contentType = 'application/json') {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf-8'),
  }
}

function audioResponse(buf, extra = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n) => {
        const h = { 'content-type': 'audio/mpeg', 'content-length': String(buf.length), ...extra }
        const v = h[n.toLowerCase()]
        return v === undefined ? null : v
      },
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf-8'),
  }
}

test('缺少密钥或音色时不调用供应商，直接返回 not_configured', async () => {
  let called = 0
  const fetchImpl = () => { called += 1; return jsonResponse(200, {}) }
  for (const cfg of [{ apiKey: '', referenceId: 'v' }, { apiKey: 'k', referenceId: '' }, {}]) {
    const r = await fish.synthesize({ text: TEXT, ...cfg, fetchImpl })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'not_configured')
  }
  assert.equal(called, 0)
})

test('配置了未知/付费模型时直接拒绝，不回落', async () => {
  let called = 0
  const fetchImpl = () => { called += 1; return jsonResponse(200, {}) }
  const r = await fish.synthesize({ text: TEXT, ...CFG, model: 's2.1-pro', fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'unknown_model')
  assert.equal(called, 0)
})

test('成功合成：显式免费模型请求头 + 正确请求体，产出有效音频与时长', async () => {
  const seen = {}
  const buf = buildCbrMp3(200) // 约 5.2 秒
  const fetchImpl = async (url, opts) => {
    seen.url = url
    seen.headers = opts.headers
    seen.body = JSON.parse(opts.body)
    return audioResponse(buf)
  }
  const r = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl })
  assert.equal(r.ok, true, r.message)
  assert.equal(seen.url, 'https://api.fish.audio/v1/tts')
  assert.equal(seen.headers.model, 's2.1-pro-free')
  assert.equal(seen.headers.authorization, 'Bearer test-key')
  assert.equal(seen.body.reference_id, 'voice-001')
  assert.equal(seen.body.text, TEXT)
  assert.equal(seen.body.format, 'mp3')
  assert.ok(r.buffer.length === buf.length)
  assert.ok(r.durationMs > 5000 && r.durationMs < 5400, `时长 ${r.durationMs}ms`)
  assert.equal(r.contentType, 'audio/mpeg')
})

test('免费模型固定不来自配置：省略 model 配置时仍显式发送 s2.1-pro-free', async () => {
  const seen = {}
  const fetchImpl = async (url, opts) => {
    seen.headers = opts.headers
    return audioResponse(buildCbrMp3(50))
  }
  const r = await fish.synthesize({ text: TEXT, apiKey: 'k', referenceId: 'v', fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(seen.headers.model, 's2.1-pro-free')
})

test('401/402/429/500 分别映射为 auth/quota/rate_limited/error', async () => {
  for (const [status, code] of [[401, 'auth'], [402, 'quota'], [429, 'rate_limited'], [500, 'error']]) {
    const r = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl: () => jsonResponse(status, { message: 'x' }) })
    assert.equal(r.ok, false)
    assert.equal(r.code, code, `HTTP ${status} 应映射为 ${code}`)
  }
})

test('HTTP 200 但返回 JSON/HTML 错误正文时不产出音频', async () => {
  const r1 = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl: () => jsonResponse(200, { code: 'err' }) })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'bad_audio')
  const r2 = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl: () => jsonResponse(200, '<html>oops</html>', 'text/html') })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'bad_audio')
})

test('响应中断（content-length 不符）与超大音频都被拒绝', async () => {
  const buf = buildCbrMp3(100)
  const r1 = await fish.synthesize({
    text: TEXT, ...CFG,
    fetchImpl: () => audioResponse(buf.slice(0, 100), { 'content-length': String(buf.length) }),
  })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'bad_audio')
  const big = Buffer.alloc(fish.MAX_AUDIO_BYTES + 1)
  const r2 = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl: () => audioResponse(big) })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'too_long')
})

test('超时有界并取消请求', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  const r = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl, timeoutMs: 20 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'timeout')
})

test('错误响应正文迟迟不结束时，超时上限内仍要返回结果（不无限等待）', async () => {
  const abortErr = () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    return e
  }
  // 模拟真实流式响应：错误正文只有在连接被中止时才结束
  const fetchImpl = async (url, opts) => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: () =>
      new Promise((_, reject) => {
        if (opts.signal.aborted) return reject(abortErr())
        opts.signal.addEventListener('abort', () => reject(abortErr()), { once: true })
      }),
  })
  const r = await Promise.race([
    fish.synthesize({ text: TEXT, ...CFG, fetchImpl, timeoutMs: 30 }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1000)),
  ])
  assert.notEqual(r, 'HUNG', '错误正文不结束时不能无限挂起')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'rate_limited')
})

test('外部取消信号生效', async () => {
  const ac = new AbortController()
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  ac.abort()
  const r = await fish.synthesize({ text: TEXT, ...CFG, fetchImpl, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'cancelled')
})

/* ---------- 音频缓存 ---------- */

function tmpCache(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-cache-'))
  const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-trash-'))
  const trashed = []
  const cache = cacheMod.createAudioCache({
    dir,
    moveToTrash: async (src) => {
      // 模拟废纸篓：真的把文件搬走，但不自动清空
      const dest = path.join(trashDir, path.basename(src))
      fs.renameSync(src, dest)
      trashed.push(path.basename(src))
      return { ok: true, dest }
    },
    ...opts,
  })
  // 清理遵守项目规则：移入废纸篓，不自动删除
  return {
    cache,
    dir,
    trashed,
    trashDir,
    cleanup: () => {
      moveToTrash(dir)
      moveToTrash(trashDir)
    },
  }
}

const PUT = (over = {}) => ({
  text: '同一份完整文案',
  model: 's2.1-pro-free',
  referenceId: 'voice-001',
  buffer: buildCbrMp3(100),
  durationMs: 2612,
  ...over,
})

test('缓存键包含完整文案、模型与音色：同输入复用，换音色/文案不复用', async () => {
  const t = tmpCache()
  try {
    const a = await t.cache.put(PUT())
    const b = await t.cache.put(PUT())
    assert.equal(a.ok, true)
    assert.equal(b.assetId, a.assetId)
    assert.equal(b.reused, true)
    const c = await t.cache.put(PUT({ referenceId: 'voice-002' }))
    assert.notEqual(c.assetId, a.assetId)
    const d = await t.cache.put(PUT({ text: '另一份文案' }))
    assert.notEqual(d.assetId, a.assetId)
  } finally {
    t.cleanup()
  }
})

test('原子发布：目录里只剩成品 mp3 与 meta，无临时文件残留', async () => {
  const t = tmpCache()
  try {
    const r = await t.cache.put(PUT())
    const files = fs.readdirSync(t.dir).sort()
    assert.deepEqual(files, [`${r.assetId}.json`, `${r.assetId}.mp3`].sort())
    const meta = t.cache.getMeta(r.assetId)
    assert.equal(meta.hit, true)
    assert.equal(meta.durationMs, 2612)
  } finally {
    t.cleanup()
  }
})

test('并发相同输入不产生半成品或重复发布', async () => {
  const t = tmpCache()
  try {
    const results = await Promise.all([t.cache.put(PUT()), t.cache.put(PUT()), t.cache.put(PUT())])
    for (const r of results) assert.equal(r.ok, true)
    assert.equal(new Set(results.map((r) => r.assetId)).size, 1)
    const files = fs.readdirSync(t.dir)
    assert.equal(files.filter((f) => f.endsWith('.mp3')).length, 1)
  } finally {
    t.cleanup()
  }
})

test('TTL 过期淘汰：移入废纸篓，不影响无关文件，不自动清空废纸篓', async () => {
  const t = tmpCache({ ttlMs: 1000 })
  try {
    const a = await t.cache.put(PUT({ text: 'A', now: 1000 }))
    // 无关文件必须幸存
    const bystander = path.join(t.dir, 'not-an-asset.txt')
    fs.writeFileSync(bystander, 'keep me')
    await t.cache.prune({ now: 3000 })
    assert.ok(t.trashed.includes(`${a.assetId}.mp3`), '过期文件应进废纸篓')
    assert.ok(!fs.existsSync(path.join(t.dir, `${a.assetId}.mp3`)))
    assert.ok(fs.existsSync(bystander), '无关文件不能被淘汰')
    assert.deepEqual(fs.readdirSync(t.dir).filter((f) => f.includes('.trash')), [])
  } finally {
    t.cleanup()
  }
})

test('容量上限与使用中保护：腾不出空间本次降级，释放后可淘汰', async () => {
  const t = tmpCache({ maxBytes: 60 * 1024 })
  try {
    const big = buildCbrMp3(2000) // ~834KB，单个就超过上限
    const r0 = await t.cache.put(PUT({ buffer: big, text: 'big' }))
    assert.equal(r0.ok, false)
    assert.equal(r0.code, 'cache_full')

    const a = await t.cache.put(PUT({ text: 'A' })) // ~417KB
    const b = await t.cache.put(PUT({ text: 'B' })) // 挤掉 A
    assert.equal(b.ok, true)
    assert.equal(fs.existsSync(path.join(t.dir, `${a.assetId}.mp3`)), false, 'A 应被淘汰腾地')

    // C 需要空间，但 B 正在使用 → 本次降级
    t.cache.retain(b.assetId)
    const c = await t.cache.put(PUT({ text: 'C' }))
    assert.equal(c.ok, false)
    assert.equal(c.code, 'cache_full')
    assert.equal(fs.existsSync(path.join(t.dir, `${b.assetId}.mp3`)), true, '使用中的音频受保护')

    // 释放后可以腾挪
    t.cache.release(b.assetId)
    const d = await t.cache.put(PUT({ text: 'C' }))
    assert.equal(d.ok, true)
  } finally {
    t.cleanup()
  }
})

test('损坏缓存（meta 不可解析）按缺失处理并可被清理', async () => {
  const t = tmpCache()
  try {
    const r = await t.cache.put(PUT())
    fs.writeFileSync(path.join(t.dir, `${r.assetId}.json`), '{broken')
    const meta = t.cache.getMeta(r.assetId)
    assert.equal(meta.hit, false)
    assert.equal(meta.corrupt, true)
    await t.cache.prune()
    assert.equal(fs.existsSync(path.join(t.dir, `${r.assetId}.mp3`)), false)
  } finally {
    t.cleanup()
  }
})

test('pathFor 只接受本缓存内的资产 id，拒绝路径穿越', async () => {
  const t = tmpCache()
  try {
    const r = await t.cache.put(PUT())
    assert.equal(t.cache.pathFor(r.assetId), path.join(t.dir, `${r.assetId}.mp3`))
    assert.equal(t.cache.pathFor('../secrets.json'), null)
    assert.equal(t.cache.pathFor('not-a-hash'), null)
    assert.equal(t.cache.pathFor('../../etc/passwd'), null)
    const missing = t.cache.pathFor('a'.repeat(64))
    assert.equal(missing, null)
  } finally {
    t.cleanup()
  }
})

test('时长有效性标记：超过 30 秒无效，短于 15 秒记录偏差', async () => {
  assert.deepEqual(fish.evaluateAudioDuration(31000), { withinProgramLimit: false, code: 'audio_too_long', deviation: null })
  const short = fish.evaluateAudioDuration(12000)
  assert.equal(short.withinProgramLimit, true)
  assert.equal(short.deviation, 'below_target_seconds')
  assert.deepEqual(fish.evaluateAudioDuration(20000), { withinProgramLimit: true, code: null, deviation: null })
})

test('失效音色是配置错误，提示更换音色而非临时服务失败', async () => {
  const r = await fish.synthesize({ text: TEXT, ...CFG,
    fetchImpl: async () => jsonResponse(400, { message: 'Reference not found', status: 400 }),
  })
  assert.equal(r.code, 'invalid_reference')
  assert.match(r.message, /音色.*不存在|音色.*失效/)
})
