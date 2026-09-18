import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 迁移后测试目标：apps/web/src/orchestration 的 TS 实现（原 public/segue-controller.js）
const c = require('@radio/contracts')
const { SegueController } = require('../../apps/web/dist-playback/orchestration/segue-controller.cjs')

/* ---------- 测试基建：可控时钟 + 可控的替身准备请求 ---------- */

function deferred() {
  let resolve!: (value: any) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 冲刷微任务：让已 resolve 的替身结果走完 .then 链。 */
const flush = () => new Promise((r) => setImmediate(r))

function makeHarness({ interval = 4, enabled = true } = {}) {
  let clock = 1000000
  const prepareCalls: any[] = []
  const inflight: ReturnType<typeof deferred>[] = [] // 与 prepareCalls 对齐的 deferred
  const cancels: { segueId: any; reason: any }[] = []
  const controller = new SegueController({
    requestPrepare: async (req: any) => {
      prepareCalls.push(req)
      const d = deferred()
      inflight.push(d)
      return d.promise
    },
    cancelPrepare: (segueId: any, reason: any) => cancels.push({ segueId, reason }),
    now: () => clock,
  })
  controller.startSession({ sessionId: 'sess-t', epoch: 1 })
  controller.setConfig({ djEnabled: enabled, djIntervalTracks: interval })
  const tracks = [1, 2, 3, 4, 5, 6].map((n) => c.makeTrackItem({ id: 100 + n, name: `歌${n}`, artists: '歌手' }))
  let pi = 0
  const h = {
    controller,
    tracks,
    prepareCalls,
    inflight,
    cancels,
    now: () => clock,
    tick: (ms: number) => {
      clock += ms
    },
    start(trackIdx: number, nextIdx: number|null|undefined, opts: { nextPlayable?: boolean } = {}) {
      return controller.onTrackStarted({
        item: tracks[trackIdx],
        next: nextIdx === undefined || nextIdx === null ? null : tracks[nextIdx],
        nextPlayable: opts.nextPlayable,
        playInstanceId: `pi_${++pi}`,
        at: clock,
      })
    },
    end(trackIdx: number) {
      return controller.onTrackEnded({ item: tracks[trackIdx], playInstanceId: `pi_${pi}`, natural: true, at: clock })
    },
    lastDeferred: () => inflight[inflight.length - 1],
    /** 让最近一次准备请求以对齐当前机会的 ready 结果完成。 */
    async readyWithSample() {
      const job = c.SAMPLES.readyJob()
      const req = prepareCalls[prepareCalls.length - 1]
      job.segueId = `sg_${prepareCalls.length}`
      job.transition.transitionId = req.transitionId
      job.transition.targetItemId = req.targetItemId
      job.transition.targetTrackId = req.targetTrackId
      job.script.targetItemId = req.targetItemId
      job.script.transitionId = req.transitionId
      job.script.targetTrackId = req.targetTrackId
      inflight[inflight.length - 1].resolve!({ state: 'ready', segueId: job.segueId, script: job.script, audio: job.audio })
      await flush()
      return job
    },
  }
  return h
}

const played3 = (h: { controller?: any; tracks?: any[]; prepareCalls?: any[]; inflight?: any[]; cancels?: any[]; now?: () => number; tick?: (ms: any) => void; start: any; end: any; lastDeferred?: () => any; readyWithSample?: () => Promise<any> }) => {
  for (let i = 0; i < 3; i++) {
    h.start(i, i + 1)
    h.end(i)
  }
}

/* ---------- 1. 默认间隔：每 4 首自然结束一次 ---------- */

test('默认四首自然结束触发一次；前三首结束不播', async () => {
  const h = makeHarness()
  for (let i = 0; i < 3; i++) {
    h.start(i, i + 1)
    const d = h.end(i)
    assert.equal(d.type, 'continue-track', `第 ${i + 1} 首结束不应播 DJ`)
  }
  // 进入第 4 首：count=3 = interval-1 → 提前为第 5 首准备
  h.start(3, 4)
  assert.equal(h.prepareCalls.length, 1)
  assert.equal(h.prepareCalls[0].targetTrackId, h.tracks[4].trackId)
  assert.equal(h.prepareCalls[0].targetItemId, h.tracks[4].itemId)
  await h.readyWithSample()
  const d = h.end(3)
  assert.equal(d.type, 'play-segue')
  assert.equal(d.segue.script.targetTrackId, h.tracks[4].trackId)
  assert.ok(d.segue.audio.url.startsWith('/api/dj/audio/'))
})

test('准备请求携带紧邻下一首的歌名与歌手（生成器要用它们搜索）', () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  assert.equal(h.prepareCalls.length, 1)
  assert.equal(h.prepareCalls[0].targetTrackId, h.tracks[4].trackId)
  assert.equal(h.prepareCalls[0].targetName, h.tracks[4].name)
  assert.equal(h.prepareCalls[0].targetArtists, h.tracks[4].artists)
})

test('自然结束计数以播放实例去重：同一 ended 只累计一次', () => {
  const h = makeHarness()
  h.start(0, 1)
  h.end(0)
  const again = h.controller.onTrackEnded({ item: h.tracks[0], playInstanceId: 'pi_1', natural: true, at: h.now() })
  assert.equal(again.type, 'none')
  assert.equal(h.controller.snapshot().naturalCount, 1)
})

test('非自然结束（natural=false）不累计', () => {
  const h = makeHarness()
  h.start(0, 1)
  h.controller.onTrackEnded({ item: h.tracks[0], playInstanceId: 'pi_1', natural: false, at: h.now() })
  assert.equal(h.controller.snapshot().naturalCount, 0)
})

/* ---------- 2. 就绪顺序与迟到结果 ---------- */

test('就绪晚于自然结束：机会关闭后迟到结果失去排程资格，不重新插入', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4) // 发起准备
  const d = h.end(3) // 结束时还没 ready
  assert.equal(d.type, 'continue-track')
  assert.equal(h.controller.snapshot().naturalCount, 4, '计数保持到期')
  assert.equal(h.controller.snapshot().transitionId, null, '机会已关闭')
  // 迟到的 ready
  h.inflight[0].resolve!({ state: 'ready', segueId: 'sg_late', script: c.SAMPLES.sourcedScript(), audio: c.SAMPLES.readyJob().audio })
  await flush()
  assert.equal(h.controller.snapshot().state, 'idle', '迟到结果被丢弃')
  // 进入第 5 首：按新机会重新准备（count 仍到期）
  h.start(4, 5)
  assert.equal(h.prepareCalls.length, 2)
  assert.equal(h.prepareCalls[1].targetTrackId, h.tracks[5].trackId)
  await h.readyWithSample()
  const d2 = h.end(4)
  assert.equal(d2.type, 'play-segue')
})

test('就绪早于自然结束：正常播放', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  await h.readyWithSample()
  const d = h.end(3)
  assert.equal(d.type, 'play-segue')
})

/* ---------- 3. 计数语义 ---------- */

test('跳过与播放失败不累计', () => {
  const h = makeHarness()
  h.start(0, 1)
  h.controller.onSkipped({ at: h.now() }) // 手动下一首
  h.start(1, 2)
  h.controller.onTrackFailed({ item: h.tracks[1], at: h.now() }) // 解析/播放失败
  h.start(2, 3)
  h.end(2)
  assert.equal(h.controller.snapshot().naturalCount, 1)
})

test('DJ 首次实际出声才重置计数；暂停恢复的后续 playing 不再清零', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  await h.readyWithSample()
  assert.equal(h.end(3).type, 'play-segue')
  const sg = h.controller.snapshot().segueId
  h.controller.onSeguePlaying({ segueId: sg, at: h.now() })
  assert.equal(h.controller.snapshot().naturalCount, 0)
  h.controller.onSeguePlaying({ segueId: sg, at: h.now() }) // 暂停恢复后再 playing
  assert.equal(h.controller.snapshot().naturalCount, 0)
  // 之后一首结束：count=1，不再触发
  h.start(4, 5)
  h.end(4)
  assert.equal(h.controller.snapshot().naturalCount, 1)
})

test('DJ 已出声被跳过：本轮机会算使用，下一首结束不会立刻再说', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  await h.readyWithSample()
  h.end(3)
  const sg = h.controller.snapshot().segueId
  h.controller.onSeguePlaying({ segueId: sg, at: h.now() })
  h.controller.onSegueSkipped({ segueId: sg, at: h.now() })
  h.start(4, 5)
  h.end(4)
  assert.equal(h.controller.snapshot().naturalCount, 1)
  assert.equal(h.prepareCalls.length, 1, '未到间隔不准备')
})

test('DJ 未出声就失败/被取消：计数保持到期，下一机会可再准备', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  await h.readyWithSample()
  h.end(3) // 决定播 DJ
  const sg = h.controller.snapshot().segueId
  h.controller.onSegueFailed({ segueId: sg, started: false, at: h.now() }) // 加载失败，从未出声
  h.start(4, 5)
  assert.equal(h.controller.snapshot().naturalCount, 4, '计数未被清零')
  assert.equal(h.prepareCalls.length, 2, '立即为新机会再准备')
})

/* ---------- 4. 目标与机会生命周期 ---------- */

test('目标替换（队列改变）：旧机会关闭，为新目标准备；旧结果迟到被丢弃', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  assert.equal(h.prepareCalls.length, 1)
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() }) // 补歌把下一首换了
  assert.equal(h.cancels.length, 0, '旧请求还没拿到 segueId，取消以丢弃为主')
  assert.equal(h.controller.snapshot().targetItemId, h.tracks[5].itemId)
  // 旧请求迟到 resolve（指向旧目标）→ 被丢弃
  h.inflight[0].resolve!({ state: 'ready', segueId: 'sg_old', script: c.SAMPLES.sourcedScript(), audio: c.SAMPLES.readyJob().audio })
  await flush()
  assert.notEqual(h.controller.snapshot().state, 'ready')
  await h.readyWithSample()
  const d = h.end(3)
  assert.equal(d.type, 'play-segue')
  assert.equal(d.segue.script.targetTrackId, h.tracks[5].trackId)
})

test('同一首歌重复入队：不同 itemId 各自绑定机会，不串台', async () => {
  const h = makeHarness()
  // tracks[4].trackId = 105；两份重复入队条目同 trackId、不同 itemId
  const dupA = c.makeTrackItem({ id: h.tracks[4].trackId, name: h.tracks[4].name, artists: '歌手' })
  const dupB = c.makeTrackItem({ id: h.tracks[4].trackId, name: h.tracks[4].name, artists: '歌手' })
  played3(h)
  h.start(3, null)
  assert.equal(h.prepareCalls.length, 0, '没有下一首不准备')
  h.controller.onQueueChanged({ next: dupA, at: h.now() })
  assert.equal(h.prepareCalls.length, 1)
  const t1 = h.prepareCalls[0].transitionId
  await h.readyWithSample()
  // 队列又变：目标换成另一份重复入队条目，旧就绪成品作废并取消
  h.controller.onQueueChanged({ next: dupB, at: h.now() })
  assert.equal(h.prepareCalls.length, 2)
  assert.notEqual(h.prepareCalls[1].transitionId, t1)
  assert.notEqual(h.prepareCalls[1].targetItemId, dupA.itemId)
  assert.ok(h.cancels.some((x) => x.segueId === 'sg_1'), '旧就绪成品被取消')
  await h.readyWithSample()
  const d = h.end(3)
  assert.equal(d.type, 'play-segue')
  assert.equal(d.segue.script.targetItemId, dupB.itemId, '播报绑定的是新目标条目')
})

test('队尾等待补歌：先继续歌曲，补歌结果到达后按新目标准备', () => {
  const h = makeHarness()
  played3(h)
  h.start(3, null) // 队尾，下一首还没补到
  assert.equal(h.prepareCalls.length, 0)
  const d = h.end(3)
  assert.equal(d.type, 'continue-track')
  h.start(4, null)
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() }) // 补歌到达
  assert.equal(h.prepareCalls.length, 1)
  assert.equal(h.prepareCalls[0].targetItemId, h.tracks[5].itemId)
})

test('目标不可播（已知）时不准备也不播放', () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4, { nextPlayable: false })
  assert.equal(h.prepareCalls.length, 0)
  h.controller.onQueueChanged({ next: h.tracks[4], nextPlayable: true, at: h.now() })
  assert.equal(h.prepareCalls.length, 1)
})

/* ---------- 5. 暂停 / 停止 / epoch ---------- */

test('暂停时不启动新准备；恢复后启动；暂停期间到达的结果保留', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4) // count=3 → 立即准备
  h.controller.onPaused({ at: h.now() })
  // 暂停期间目标变更：不启动新准备
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() })
  assert.equal(h.prepareCalls.length, 1, '暂停阻止新准备')
  h.controller.onResumed({ at: h.now() })
  assert.equal(h.prepareCalls.length, 2, '恢复后为新目标准备')
  await h.readyWithSample()
  assert.equal(h.controller.snapshot().state, 'ready')
})

test('暂停期间结果到达只更新状态；停止清空机会、计数与任务绑定', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  h.controller.onPaused({ at: h.now() })
  await h.readyWithSample()
  assert.equal(h.controller.snapshot().state, 'paused', '暂停状态优先展示')
  assert.ok(h.controller.snapshot().ready, '在途结果被保留')
  h.controller.onStopped({ at: h.now() })
  const s = h.controller.snapshot()
  assert.equal(s.naturalCount, 0)
  assert.equal(s.transitionId, null)
  assert.equal(s.state, 'stopped')
  // 停止后的迟到结果不复活任何状态
  const d = h.controller.onTrackEnded({ item: h.tracks[3], playInstanceId: 'pi_9', natural: true, at: h.now() })
  assert.equal(d.type, 'none')
})

test('epoch 变更（切来源/新计划）：机会关闭、在途作废、计数清零', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  const oldReq = h.prepareCalls[0]
  h.controller.setEpoch(2)
  h.inflight[0].resolve!({ state: 'ready', segueId: 'sg_x', script: c.SAMPLES.sourcedScript(), audio: c.SAMPLES.readyJob().audio })
  await flush()
  const s = h.controller.snapshot()
  assert.equal(s.epoch, 2)
  assert.equal(s.naturalCount, 0)
  assert.equal(s.transitionId, null)
  assert.equal(s.state, 'idle')
  assert.equal(oldReq.epoch, 1)
})

/* ---------- 6. 冷却与配置 ---------- */

test('连续服务失败进入有界冷却；冷却期不发起请求，到期后恢复', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  h.lastDeferred().resolve!({ state: 'unavailable', code: 'script_failed', message: 'x' })
  await flush()
  h.start(4, 5) // count 到期，但冷却中
  assert.equal(h.prepareCalls.length, 1, '冷却期内不发起第 2 次')
  h.tick(60 * 1000 + 1)
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() }) // 冷却到期，重新评估
  assert.equal(h.prepareCalls.length, 2, '冷却到期后恢复准备')
  h.lastDeferred().resolve!({ state: 'unavailable', code: 'script_failed', message: 'x' })
  await flush()
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() })
  assert.equal(h.prepareCalls.length, 2, '第二次冷却（120 秒）内不再发起')
  h.tick(60 * 1000 + 1)
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() })
  assert.equal(h.prepareCalls.length, 2, '120 秒冷却未到仍不发起')
  h.tick(60 * 1000)
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() })
  assert.equal(h.prepareCalls.length, 3)
})

test('配置/认证错误在配置更新前不重复请求', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  h.lastDeferred().resolve!({ state: 'unavailable', code: 'not_configured', message: '缺密钥' })
  await flush()
  h.start(4, 5)
  assert.equal(h.prepareCalls.length, 1, '被阻止')
  h.controller.setConfig({ djVoiceReferenceId: 'voice-new', voiceConfigUpdated: true })
  h.controller.onQueueChanged({ next: h.tracks[5], at: h.now() })
  assert.equal(h.prepareCalls.length, 2, '配置更新后解除阻止')
})

test('成功就绪重置失败计数与冷却', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  h.lastDeferred().resolve!({ state: 'unavailable', code: 'synthesis_failed', message: 'x' })
  await flush()
  assert.ok(h.controller.snapshot().cooldownRemainingMs > 0)
  h.tick(60 * 1000 + 1)
  h.controller.onQueueChanged({ next: h.tracks[4], at: h.now() })
  await h.readyWithSample()
  assert.equal(h.controller.snapshot().cooldownRemainingMs, 0, '成功后冷却清零')
  const d = h.end(3)
  assert.equal(d.type, 'play-segue')
})

/* ---------- 7. 配置语义 ---------- */

test('间隔只接受 3/4/5；关闭 DJ 时不准备不播放', () => {
  const h = makeHarness()
  h.controller.setConfig({ djIntervalTracks: 7 })
  assert.equal(h.controller.snapshot().djIntervalTracks, 4)
  h.controller.setConfig({ djEnabled: false })
  for (let i = 0; i < 4; i++) {
    h.start(i, i + 1)
    h.end(i)
  }
  assert.equal(h.prepareCalls.length, 0)
  assert.equal(h.controller.snapshot().state, 'idle')
})

test('改频率作废未播成品，不打断已决定播放的 DJ 记账', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  await h.readyWithSample()
  h.controller.setConfig({ djIntervalTracks: 5 })
  assert.equal(h.controller.snapshot().segueId, null, '未播成品作废')
  const d = h.end(3)
  assert.equal(d.type, 'continue-track')
})

test('DJ 结束后返回继续目标歌曲的决定', async () => {
  const h = makeHarness()
  played3(h)
  h.start(3, 4)
  const job = await h.readyWithSample()
  h.end(3)
  const sg = h.controller.snapshot().segueId
  const d = h.controller.onSegueEnded({ segueId: sg, at: h.now() })
  assert.equal(d.type, 'continue-track')
  assert.equal(d.targetItemId, job.script.targetItemId)
})

test('无效音色阻塞重试，异步结果通知界面，换音色后当前机会立即恢复', async () => {
  const h = makeHarness()
  const changes: { (): any; new(): any; blockedReason: unknown }[] = []
  h.controller.onChange = () => changes.push(h.controller.snapshot())
  played3(h)
  h.start(3, 4)
  h.lastDeferred().resolve!({ state: 'unavailable', code: 'invalid_reference', message: '音色失效' })
  await flush()
  assert.equal(h.controller.snapshot().blockedReason, 'invalid_reference')
  assert.equal(changes.at(-1)?.blockedReason, 'invalid_reference')
  h.controller.setConfig({ voiceConfigUpdated: true })
  assert.equal(h.prepareCalls.length, 2)
  assert.equal(h.controller.snapshot().cooldownRemainingMs, 0)
})
