/**
 * PlaybackController 行为回归（M3，TDD）：迁移 public/app.js 的媒体执行语义。
 * 用假 audio 元素（事件总线 + 可控属性）在 Node 下确定性验证媒体归属、代次、失败恢复。
 * 这些测试对应 docs/plans/2026-09-17-stack-migration.md §5.1 的行为合同。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deferred } from './support/deferred.mts'
import type { TrackItem } from '@radio/contracts'
import type { ResolveResult, AudioPort } from '../dist-playback/playback/playback-types.js'

// TS 源码经 tsc 编译后测试（web 的 build 脚本先跑 tsc）
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// 直接用 tsx 不可用时：本测试经 npm run build:playback 产出的 CJS 副本验证
const { PlaybackController }: typeof import('../dist-playback/playback/playback-controller.js') = require(path.join(root, 'apps/web/dist-playback/playback-controller.cjs'))

/** 假 audio：记录事件监听器，可控属性。 */
interface FakeAudio extends AudioPort {
  listeners: Map<string, Set<() => void>>
  emit: (type: string) => void
  pausedCalls: number
}
function fakeAudio(): FakeAudio {
  const listeners = new Map<string, Set<() => void>>()
  return {
    listeners,
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    emit(type: string) {
      for (const fn of listeners.get(type) || []) fn()
    },
    preload: '',
    paused: true,
    currentTime: 0,
    duration: NaN,
    readyState: 0,
    src: '',
    currentSrc: '',
    error: null,
    pausedCalls: 0,
    play() {
      this.paused = false
      this.pausedCalls += 0
      return Promise.resolve()
    },
    pause() {
      this.paused = true
      this.pausedCalls += 1
    },
    removeAttribute() {
      this.src = ''
      this.currentSrc = ''
    },
  }
}

const TRACK_A: TrackItem = { itemId: 'itn_a', type: 'track', trackId: 101, name: '曲A', artists: '歌手', album: '', durationMs: 200000, auto: false, fromCodex: false, addedAt: 1 }
const TRACK_B: TrackItem = { itemId: 'itn_b', type: 'track', trackId: 102, name: '曲B', artists: '歌手', album: '', durationMs: 200000, auto: false, fromCodex: false, addedAt: 2 }

function setup(queue = [TRACK_A, TRACK_B]) {
  const audio = fakeAudio()
  const events: Array<[string, ...unknown[]]> = []
  const ctl = new PlaybackController({
    audio,
    events: {
      onFirstPlaying: (item) => events.push(['first-playing', item?.trackId]),
      onNaturalEnded: (item) => events.push(['natural-ended', item?.trackId]),
      onTrackFailed: (item, reason) => events.push(['failed', item?.trackId, reason]),
      onSeguePlaying: () => events.push(['segue-playing']),
      onSegueEnded: () => events.push(['segue-ended']),
      onSegueFailed: (id, started) => events.push(['segue-failed', id, started]),
      onPreviewFailed: (m) => events.push(['preview-failed', m]),
    },
  })
  ctl.replaceQueue(queue)
  ctl.resolveTrack = async (id, force) => ({
    ok: true, playable: true, audioUrl: `/api/audio/${id}${force ? '?force=1' : ''}`,
  })
  return { ctl, audio, events }
}

test('播放后 playing 事件记到当前播放实例，首次出声只触发一次', async () => {
  const { ctl, audio, events } = setup()
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.emit('playing')
  audio.emit('playing') // 暂停恢复前第二次 playing 不重复记账
  assert.deepEqual(events.filter((e) => e[0] === 'first-playing').length, 1)
  const snap = ctl.getSnapshot()
  assert.equal(snap.currentTrackId, 101)
  assert.equal(snap.loadedTrackId, 101)
  assert.equal(snap.mediaPlayInstance, snap.mediaPlayInstance) // 已登记
})

test('切歌解析期间旧媒体的 ended/error 不算到新条目头上', async () => {
  const { ctl, audio, events } = setup()
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.emit('playing') // 曲A 真实在播

  // 立即切到曲B：媒体里还是曲A
  const p = ctl.play(1)
  // 曲A 的旧 ended 在切歌后到达：媒体归属不匹配 → 不算自然结束
  audio.emit('ended')
  await p
  assert.equal(events.filter((e) => e[0] === 'natural-ended').length, 0)
})

test('加载中暂停：迟到的解析结果不把播放重新拉起来', async () => {
  const { ctl, audio } = setup()
  let resolveFetch!: (value: ResolveResult) => void
  ctl.resolveTrack = () => new Promise((r) => (resolveFetch = r))
  const p = ctl.play(0)
  assert.equal(ctl.getSnapshot().resolving, true)
  ctl.pause() // 加载中暂停：代次自增
  resolveFetch!({ ok: true, playable: true, audioUrl: '/api/audio/101' })
  await p
  const snap = ctl.getSnapshot()
  assert.equal(snap.userWantsPlayback, false)
  assert.equal(snap.resolving, false)
  // 媒体没有被赋 src（解析结果被丢弃）
  assert.equal(audio.src, '')
})

test('同曲重播：旧实例的 ended 不算新播放的自然结束', async () => {
  const { ctl, audio, events } = setup([TRACK_A])
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.emit('playing')
  const firstSnap = ctl.getSnapshot()
  assert.notEqual(firstSnap.mediaPlayInstance, null)

  // 重新开始同一条目（重播）：新 playInstance，旧媒体事件应被过滤
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.emit('playing')
  // 旧播放实例的 ended 到达（模拟迟到的旧事件）——tracker 已 replace，markEnded 应失败
  audio.emit('ended')
  assert.equal(events.filter((e) => e[0] === 'natural-ended').length, 1)
  // 只有当前实例的有效 ended 才算（当前还在播，没有真的 ended）
})

test('单曲失败按 reason 分类并触发 onTrackFailed；连续 3 次触发上限回调', async () => {
  const { ctl, audio, events } = setup()
  ctl.resolveTrack = async () => ({ ok: false, code: 'trial_only', message: '试听' })
  let exceeded = 0
  ctl.onConsecutiveFailuresExceeded = () => (exceeded += 1)
  ctl.retryAfterFailure = () => {} // 不自动换歌，手动驱动
  await ctl.play(0)
  await ctl.play(0)
  await ctl.play(0)
  assert.equal(events.filter((e) => e[0] === 'failed').length, 3)
  assert.equal(exceeded, 1)
  const snap = ctl.getSnapshot()
  assert.equal(snap.userWantsPlayback, false)
})

test('试听与正式节目共享音频出口但身份独立；开播作废试听', async () => {
  const { ctl, audio, events } = setup()
  const ok = await ctl.startPreview('/api/dj/audio/abc')
  assert.equal(ok, true)
  assert.equal(ctl.getSnapshot().previewing, true)
  // 开播（用户手势）：试听作废，媒体被歌曲接管
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.emit('playing')
  assert.equal(ctl.getSnapshot().previewing, false)
  assert.equal(events.filter((e) => e[0] === 'first-playing').length, 1)
})

test('DJ 串场：出声/结束/失败事件独立于歌曲计数路径', async () => {
  const { ctl, audio, events } = setup()
  await ctl.playSegue({ segueId: 'sg_1', audio: { url: '/api/dj/audio/xyz', durationMs: 18000 }, script: {} })
  audio.currentSrc = audio.src
  audio.emit('playing')
  audio.emit('ended')
  assert.deepEqual(
    events.filter((e) => ['segue-playing', 'segue-ended'].includes(e[0])).map((e) => e[0]),
    ['segue-playing', 'segue-ended'],
  )
  // DJ 的 ended 不触发歌曲的自然结束
  assert.equal(events.filter((e) => e[0] === 'natural-ended').length, 0)
  assert.equal(ctl.getSnapshot().currentKind, 'track')
})

test('dispose 后不再响应媒体事件且清空订阅', async () => {
  const { ctl, audio, events } = setup()
  await ctl.play(0)
  audio.currentSrc = audio.src
  ctl.dispose()
  audio.emit('playing')
  audio.emit('ended')
  assert.equal(events.filter((e) => e[0] === 'first-playing').length, 0)
  assert.equal(events.filter((e) => e[0] === 'natural-ended').length, 0)
})

test('订阅/退订：React useSyncExternalStore 协议', async () => {
  const { ctl, audio } = setup()
  let calls = 0
  const unsub = ctl.subscribe(() => (calls += 1))
  ctl.pause()
  assert.ok(calls >= 1)
  unsub()
  const before = calls
  ctl.pause()
  assert.equal(calls, before)
})

for (const nextIntent of ['switch', 'stop', 'pause'] as const) {
  test(`恢复 A 后${nextIntent}，A 的迟到拒绝不产生失败或干扰新意图`, async () => {
    const { ctl, audio, events } = setup()
    await ctl.play(0)
    audio.currentSrc = audio.src
    audio.currentTime = 10
    audio.emit('playing')
    ctl.pause()
    const pending = deferred<void>()
    audio.play = () => pending.promise
    const resumed = ctl.resume()
    audio.play = () => { audio.paused = false; return Promise.resolve() }
    if (nextIntent === 'switch') await ctl.play(1)
    else ctl[nextIntent]()
    pending.reject(new Error('old resume failed'))
    await resumed
    assert.deepEqual(events.filter(e => e[0] === 'failed'), [])
    assert.equal(ctl.getSnapshot().currentTrackId, nextIntent === 'switch' ? 102 : 101)
    assert.equal(audio.paused, nextIntent !== 'switch')
    ctl.dispose()
  })
}

test('当前恢复被浏览器拒绝仍提示原歌曲，正常恢复不重复记账', async () => {
  const { ctl, audio, events } = setup()
  await ctl.play(0)
  audio.currentSrc = audio.src
  audio.currentTime = 10
  audio.emit('playing')
  ctl.pause()
  await ctl.resume()
  audio.emit('playing')
  assert.equal(events.filter(e => e[0] === 'first-playing').length, 1)
  ctl.pause()
  audio.play = async () => { throw new Error('blocked') }
  await ctl.resume()
  assert.deepEqual(events.filter(e => e[0] === 'failed'), [['failed', 101, '浏览器拒绝播放：blocked']])
  ctl.dispose()
})

test('停止试听作废迟到的 play，且歌曲播放期间取消试听不打断歌曲', async () => {
  const { ctl, audio } = setup()
  const pending = deferred<void>()
  audio.play = () => { audio.paused = false; return pending.promise }
  const preview = ctl.startPreview('/api/dj/audio/preview')
  ctl.cancelPreview()
  pending.resolve()
  assert.equal(await preview, false)
  assert.equal(audio.paused, true)
  audio.play = () => { audio.paused = false; return Promise.resolve() }
  await ctl.play(0)
  ctl.cancelPreview()
  assert.equal(audio.paused, false)
  assert.equal(ctl.getSnapshot().currentTrackId, 101)
  ctl.dispose()
})
