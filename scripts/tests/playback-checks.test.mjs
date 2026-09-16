import test from 'node:test'
import assert from 'node:assert/strict'
import { isBatchTrackPlaying } from '../lib/playback-checks.mjs'

test('歌名切到补入曲但音频仍是已结束的旧曲时，不能判为续播成功', () => {
  const previous = {
    currentId: 1, loadedId: 1, currentTime: 198.6,
    autoQueueIds: [2], paused: false, stopped: false,
    ended: true, resolving: false, readyState: 4,
  }
  const current = { ...previous, currentId: 2, resolving: true }
  assert.equal(isBatchTrackPlaying(previous, current), false)
})

const playing = {
  currentId: 2, loadedId: 2, currentTime: 0.5,
  autoQueueIds: [2], paused: false, stopped: false,
  ended: false, resolving: false, readyState: 4,
}

test('新曲音源匹配但进度没有增长时，仍不能判为续播成功', () => {
  assert.equal(isBatchTrackPlaying(playing, { ...playing }), false)
})

test('同一首补入曲的音源匹配且进度增长时，证明已实际续播', () => {
  assert.equal(isBatchTrackPlaying(playing, { ...playing, currentTime: 1.5 }), true)
})
