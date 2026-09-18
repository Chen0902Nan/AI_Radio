import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveToTrash } from '../lib/trash.mts'

const require = createRequire(import.meta.url)
// 迁移后测试目标：apps/api/src 的 TS 实现（原 server/dj-pipeline.js 等）
const contract = require('@radio/contracts')
const fishMod = require('../../apps/api/dist/dj/fish.service.js')
const cacheMod = require('../../apps/api/dist/dj/audio-cache.js')
const { createDjPipeline } = require('../../apps/api/dist/dj/dj-pipeline.service.js')

function deferred() {
  let resolve!: (value: any) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = () => new Promise((r) => setImmediate(r))
const sleep = (ms: number|undefined) => new Promise((r) => setTimeout(r, ms))

test('语音配置诊断区分缺密钥与缺音色，更新后可用且不泄露密钥或发起合成', () => {
  let apiKey = ''
  let referenceId = ''
  const p = createDjPipeline({
    getApiKey: () => apiKey,
    settings: () => ({ djVoiceReferenceId: referenceId }),
    cache: {},
    fish: { ...fishMod, synthesize: () => assert.fail('配置诊断不能合成') },
  })
  assert.equal(p.configuration().ready, false)
  assert.match(p.configuration().message, /FISH_API_KEY/)
  apiKey = 'secret-for-test-only'
  assert.equal(p.configuration().ready, false)
  assert.match(p.configuration().message, /音色.*试听/)
  referenceId = 'chosen-voice'
  assert.equal(p.configuration().ready, true)
  assert.equal(p.configuration().voiceReferenceId, 'chosen-voice')
  assert.equal(JSON.stringify(p.configuration()).includes(apiKey), false)
})

function makeDeps(over: Record<string, any> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-pipe-'))
  const scriptCalls: any[] = []
  const fishCalls: any[] = []
  const targetCalls: any[] = []
  const scriptDefers: ReturnType<typeof deferred>[] = []
  const fishDefers: ReturnType<typeof deferred>[] = []
  let clock = 1700000000000
  const deps = {
    settings: () => ({ djVoiceReferenceId: 'voice-1', fishModel: 's2.1-pro-free' }),
    getApiKey: () => 'key-test',
    resolveTarget: async (trackId: any) => {
      targetCalls.push(trackId)
      return { kind: 'full', name: '灯塔', artists: '另一位歌手' }
    },
    djScript: {
      generateSegueScript: async (input: any) => {
        scriptCalls.push(input)
        const d = deferred()
        scriptDefers.push(d)
        return d.promise
      },
    },
    fish: {
      synthesize: async (input: any) => {
        fishCalls.push(input)
        const d = deferred()
        fishDefers.push(d)
        if (over.fishAutoResolve) d.resolve!(over.fishAutoResolve === true ? FISH_OK() : over.fishAutoResolve)
        return d.promise
      },
      evaluateAudioDuration: fishMod.evaluateAudioDuration,
      validateVoiceConfig: fishMod.validateVoiceConfig,
    },
    cache: cacheMod.createAudioCache({ dir }),
    limits: { scriptMs: 5000, ttsMs: 5000, totalMs: 20000, retentionMs: 80 },
    now: () => clock,
    ...over,
  }
  return {
    deps,
    scriptCalls,
    fishCalls,
    targetCalls,
    scriptDefers,
    fishDefers,
    dir,
    tick: (ms: number) => {
      clock += ms
    },
    // 清理遵守项目规则：移入废纸篓，不自动删除
    cleanup: () => {
      moveToTrash(dir)
    },
  }
}

const REQ = () => ({
  sessionId: 'sess-1',
  epoch: 3,
  transitionId: 'tr-1',
  fromItemId: 'itn_a',
  targetItemId: 'itn_b',
  targetTrackId: 900002,
  targetName: '灯塔',
  targetArtists: '另一位歌手',
  brief: '深夜',
})

const SCRIPT_OK = () => {
  const s = contract.SAMPLES.sourcedScript()
  return { ok: true, script: s, meta: { searchActivity: { searchEvents: 1 } } }
}
const AUDIO_MP3 = Buffer.alloc(50000)
const FISH_OK = (durationMs = 20000) => ({
  ok: true,
  buffer: AUDIO_MP3,
  contentType: 'audio/mpeg',
  bytes: AUDIO_MP3.length,
  durationMs,
  model: 's2.1-pro-free',
})

async function completeReady(d: { deps?: { settings: () => { djVoiceReferenceId: string; fishModel: string }; getApiKey: () => string; resolveTarget: (trackId: any) => Promise<{ kind: string; name: string; artists: string }>; djScript: { generateSegueScript: (input: any) => Promise<unknown> }; fish: { synthesize: (input: any) => Promise<unknown>; evaluateAudioDuration: any; validateVoiceConfig: any }; cache: any; limits: { scriptMs: number; ttsMs: number; totalMs: number; retentionMs: number }; now: () => number }; scriptCalls?: any[]; fishCalls?: any[]; targetCalls?: any[]; scriptDefers: any; fishDefers: any; dir?: string; tick?: (ms: any) => void; cleanup?: () => void }, req: { sessionId?: string; epoch?: number; transitionId: any; fromItemId?: string; targetItemId: any; targetTrackId: any; targetName?: string; targetArtists?: string; brief?: string }) {
  const s = contract.SAMPLES.sourcedScript()
  s.targetItemId = req.targetItemId
  s.transitionId = req.transitionId
  s.targetTrackId = req.targetTrackId
  d.scriptDefers[d.scriptDefers.length - 1].resolve({ ok: true, script: s, meta: {} })
  await flush()
  d.fishDefers[d.fishDefers.length - 1].resolve(FISH_OK())
  await flush()
  await flush()
}

/* ---------- 正常路径 ---------- */

test('prepare 立即返回 preparing 任务并先校验目标音源，再串行调用文案与合成', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    assert.equal(r.ok, true)
    assert.equal(r.job.state, 'preparing')
    assert.deepEqual(d.targetCalls, [900002])
    assert.equal(d.scriptCalls.length, 1)
    assert.equal(d.scriptCalls[0].targetTrackId, 900002)
    assert.equal(d.scriptCalls[0].transitionId, 'tr-1')
    await completeReady(d, REQ())
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'ready')
    assert.ok(job.audio.url.startsWith('/api/dj/audio/'))
    assert.equal(job.audio.durationMs, 20000)
    assert.equal(job.script.targetItemId, 'itn_b')
    const v = contract.validateSegueJob(job)
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.ok(fs.existsSync(path.join(d.dir, `${job.audio.assetId}.mp3`)), '音频已发布进缓存')
  } finally {
    d.cleanup()
  }
})

test('准备请求里的歌名/歌手优先于音源解析结果（真实音源接口不返回名称）', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    await p.prepare({ ...REQ(), targetName: '晴天', targetArtists: '周杰伦' })
    assert.equal(d.scriptCalls[0].targetName, '晴天')
    assert.equal(d.scriptCalls[0].targetArtists, '周杰伦')
  } finally {
    d.cleanup()
  }
})

test('同一机会重复提交复用任务；同键不同内容明确拒绝', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.prepare(REQ())
    const r2 = await p.prepare(REQ())
    assert.equal(r2.job.segueId, r1.job.segueId, '同一机会复用任务')
    assert.equal(d.scriptCalls.length, 1)
    const conflict = await p.prepare({ ...REQ(), targetItemId: 'itn_other' })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'payload_conflict')
    const conflict2 = await p.prepare({ ...REQ(), targetTrackId: 123 })
    assert.equal(conflict2.ok, false)
  } finally {
    d.cleanup()
  }
})

test('同一会话最多一条有效流水线：新机会自动作废旧机会', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.prepare(REQ())
    const r2 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(r2.ok, true)
    const j1 = p.job(r1.job.segueId).job
    assert.equal(j1.state, 'stale')
    assert.equal(j1.reason, 'superseded')
    assert.equal(p.job(r2.job.segueId).job.state, 'preparing')
  } finally {
    d.cleanup()
  }
})

/* ---------- 配置与失败 ---------- */

test('没有免费语音配置时提前返回 unavailable，不消耗 Codex 额度', async () => {
  const d = makeDeps({ getApiKey: () => null })
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    assert.equal(r.ok, true)
    await flush()
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'unavailable')
    assert.equal(job.reason, 'voice_not_configured')
    assert.equal(d.scriptCalls.length, 0)
  } finally {
    d.cleanup()
  }
})

test('文案失败按冷却处理：冷却期内新准备被拒，到期恢复', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.prepare(REQ())
    d.scriptDefers[0].resolve!({ ok: false, code: 'timeout', message: 'x' })
    await flush()
    assert.equal(p.job(r1.job.segueId).job.state, 'unavailable')
    assert.equal(p.job(r1.job.segueId).job.reason, 'script_failed')
    const r2 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 'cooldown_active')
    d.tick(60 * 1000 + 1)
    const r3 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(r3.ok, true)
  } finally {
    d.cleanup()
  }
})

test('合成认证失败阻塞后续请求，配置更新后解除', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.prepare(REQ())
    const s = contract.SAMPLES.sourcedScript()
    s.targetItemId = REQ().targetItemId
    s.transitionId = REQ().transitionId
    d.scriptDefers[0].resolve!({ ok: true, script: s, meta: {} })
    await flush()
    d.fishDefers[0].resolve!({ ok: false, code: 'auth', message: '401' })
    await flush()
    const job = p.job(r1.job.segueId).job
    assert.equal(job.state, 'unavailable')
    assert.equal(job.reason, 'synthesis_failed')
    assert.equal(job.code, 'auth')
    const r2 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 'auth_blocked')
    p.voiceConfigChanged()
    const r3 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(r3.ok, true)
  } finally {
    d.cleanup()
  }
})

test('超过 30 秒的音频不进入正式节目且不重试合成', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    const s = contract.SAMPLES.sourcedScript()
    s.targetItemId = REQ().targetItemId
    s.transitionId = REQ().transitionId
    d.scriptDefers[0].resolve!({ ok: true, script: s, meta: {} })
    await flush()
    d.fishDefers[0].resolve!(FISH_OK(31000))
    await flush()
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'unavailable')
    assert.equal(job.reason, 'audio_too_long')
    assert.equal(d.fishCalls.length, 1, '同一机会不无限重生成')
  } finally {
    d.cleanup()
  }
})

test('错误音频正文（bad_audio）映射为 audio_invalid', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    const s = contract.SAMPLES.sourcedScript()
    s.targetItemId = REQ().targetItemId
    s.transitionId = REQ().transitionId
    d.scriptDefers[0].resolve!({ ok: true, script: s, meta: {} })
    await flush()
    d.fishDefers[0].resolve!({ ok: false, code: 'bad_audio', message: '不是 MP3' })
    await flush()
    const job = p.job(r.job.segueId).job
    assert.equal(job.reason, 'audio_invalid')
  } finally {
    d.cleanup()
  }
})

test('目标不可播：不发起文案请求', async () => {
  const d = makeDeps({ resolveTarget: async () => ({ kind: 'trial' }) })
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    await flush()
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'unavailable')
    assert.equal(job.reason, 'target_unplayable')
    assert.equal(d.scriptCalls.length, 0)
  } finally {
    d.cleanup()
  }
})

/* ---------- 取消与失效 ---------- */

test('取消在途任务后，迟到的文案/音频结果不会让它重新激活；新任务不受旧任务影响', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.prepare(REQ())
    await flush() // 让 run() 走到文案阶段，替身 defer 已创建
    await p.cancel(r1.job.segueId)
    assert.equal(p.job(r1.job.segueId).job.state, 'unavailable')
    assert.equal(p.job(r1.job.segueId).job.reason, 'cancelled')
    // 迟到的文案结果：任务已取消，不得被重新激活
    const s = contract.SAMPLES.sourcedScript()
    s.targetItemId = REQ().targetItemId
    s.transitionId = REQ().transitionId
    d.scriptDefers[0].resolve!({ ok: true, script: s, meta: {} })
    await flush()
    await flush()
    assert.equal(p.job(r1.job.segueId).job.state, 'unavailable', '迟到结果不重新激活')
    // 新机会正常完成
    const r2 = await p.prepare({ ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    await completeReady(d, { ...REQ(), transitionId: 'tr-2', targetItemId: 'itn_c' })
    assert.equal(p.job(r2.job.segueId).job.state, 'ready', '新任务不被旧任务 finally 清空')
  } finally {
    d.cleanup()
  }
})

test('会话停止后任务失效，缓存仍在但不影响新会话', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    p.invalidateSession('sess-1')
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'stale')
    assert.equal(job.reason, 'session_ended')
  } finally {
    d.cleanup()
  }
})

/* ---------- 保留期与查询 ---------- */

test('完成后任务保留 5 分钟内可查，过期按失效处理', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    await completeReady(d, REQ())
    assert.equal(p.job(r.job.segueId).ok, true)
    d.tick(d.deps.limits.retentionMs + 1) // 保留期过后惰性过期
    const q = p.job(r.job.segueId)
    assert.equal(q.ok, false)
    assert.equal(q.code, 'expired')
  } finally {
    d.cleanup()
  }
})

/* ---------- 短稿偏差 ---------- */

test('basic_only 短音频允许降级使用并记录时长偏差', async () => {
  const d = makeDeps()
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.prepare(REQ())
    const s = contract.SAMPLES.basicOnlyScript()
    s.targetItemId = REQ().targetItemId
    s.transitionId = REQ().transitionId
    d.scriptDefers[0].resolve!({ ok: true, script: s, meta: {} })
    await flush()
    d.fishDefers[0].resolve!(FISH_OK(12000))
    await flush()
    const job = p.job(r.job.segueId).job
    assert.equal(job.state, 'ready')
    assert.ok(job.deviations.some((x: { code: string }) => x.code === 'below_target_seconds'), JSON.stringify(job.deviations))
  } finally {
    d.cleanup()
  }
})

/* ---------- 试听 ---------- */

test('preview 用固定短稿合成候选音色，不创建节目任务；同音色复用缓存', async () => {
  const d = makeDeps({ fishAutoResolve: true })
  try {
    const p = createDjPipeline(d.deps)
    const r1 = await p.preview({ referenceId: 'voice-cand' })
    assert.equal(r1.ok, true, r1.message)
    assert.ok(r1.audio.url.startsWith('/api/dj/audio/'))
    assert.equal(d.fishCalls.length, 1)
    assert.ok(d.fishCalls[0].text.includes('试听') || d.fishCalls[0].text.length > 0)
    assert.equal(p.stats().prepares, 0, '试听不创建节目任务')
    const r2 = await p.preview({ referenceId: 'voice-cand' })
    assert.equal(r2.audio.assetId, r1.audio.assetId, '同输入复用缓存')
    assert.equal(d.fishCalls.length, 1)
    const r3 = await p.preview({ referenceId: 'voice-cand-2' })
    assert.equal(d.fishCalls.length, 2, '换音色重新合成')
    assert.equal(r3.audio.assetId !== r1.audio.assetId, true)
  } finally {
    d.cleanup()
  }
})

test('preview 无配置时明确失败，不发起合成', async () => {
  const d = makeDeps({ getApiKey: () => null })
  try {
    const p = createDjPipeline(d.deps)
    const r = await p.preview({ referenceId: 'voice-cand' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'not_configured')
    assert.equal(d.fishCalls.length, 0)
  } finally {
    d.cleanup()
  }
})

test('DJ任务终态发布带会话与机会身份的状态通知', async () => {
  const messages: any[] = []
  const d = makeDeps({ onStatus: (msg: any) => messages.push(msg) })
  const p = createDjPipeline(d.deps)
  try {
    const req = REQ()
    const r = await p.prepare(req)
    await completeReady(d, req)
    assert.ok(messages.some(m => m.type === 'dj-status' && m.state === 'ready' && m.segueId === r.job.segueId && m.sessionId === req.sessionId && m.epoch === req.epoch && m.transitionId === req.transitionId))
  } finally { p._dispose(); d.cleanup() }
})
