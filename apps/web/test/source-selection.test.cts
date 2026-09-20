const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const { setup, flush, item, deferredFor }: import('./support/runtime.cts').RuntimeSupport = require('./support/runtime.cts')

test('点选自动推荐的歌曲后实际播放只按手动歌曲记账，DJ 版本同步', async t => {
  const { runtime, audio, records } = setup(t, [101, 102, 103, 104, 105])
  runtime.playback.replaceQueue([item(101), { ...item(102), auto: true, selectionId: 'automatic-selection' }, item(103), item(104), item(105)])
  await runtime.sources.playManual(102)
  audio.emit('playing'); await flush()
  assert.equal(records.length, 1)
  assert.equal(records[0].trackId, 102)
  assert.equal(records[0].selectionId, undefined)
  assert.equal(runtime.segue.snapshot().epoch, runtime.refill.epoch)
})

test('歌单请求在卸载后成功也不替换队列', async t => {
  const pending = deferredFor('playlist')
  const { runtime } = setup(t, [101], { playlist: () => pending.promise })
  const controller = new AbortController()
  const loading = runtime.sources.playlist(9, '旧歌单', controller.signal)
  controller.abort()
  pending.resolve({ ok: true, tracks: [{ id: 200, name: '旧歌', artists: '', album: '', durationMs: 1000 }], returned: 1, trackCount: 1, via: 'fixture' })
  assert.equal(await loading, null)
  assert.deepEqual(runtime.playback.queue, [])
})

test('旧 Codex 请求失败不覆盖手动切换后的队列与提示', async t => {
  const pending = deferredFor('plan')
  const { runtime } = setup(t, [101], { plan: () => pending.promise })
  const request = runtime.sources.plan('旧要求')
  runtime.selectManual([item(200)], '新歌单')
  const before = runtime.store.get().status
  pending.reject(null)
  assert.match((await request).text, /忽略旧选歌结果/)
  assert.deepEqual(runtime.playback.queue.map(t => t.trackId), [200])
  assert.deepEqual(runtime.store.get().status, before)
})

test('停止后歌单的迟到成功不改变队列和停止提示', async t => {
  const pending = deferredFor('playlist')
  const { runtime, audio } = setup(t, [101], { playlist: () => pending.promise })
  const request = runtime.sources.playlist(9, '旧歌单')
  await runtime.stopListening()
  pending.resolve({ ok: true, tracks: [{ id: 200, name: '旧歌', artists: '', album: '', durationMs: 1000 }], returned: 1, trackCount: 1, via: 'fixture' })
  assert.equal(await request, null)
  assert.deepEqual(runtime.playback.queue, [])
  assert.equal(runtime.store.get().status.text, '已停止收听。')
  assert.equal(audio.paused, true)
})
