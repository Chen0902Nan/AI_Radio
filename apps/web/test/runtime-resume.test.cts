const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const { setup, flush, deferred }: import('./support/runtime.cjs').RuntimeSupport = require('./support/runtime.cts')
const { SAMPLES }: typeof import('@radio/contracts') = require('@radio/contracts')

test('A 恢复的迟到拒绝不结束 B 记录或取消 B 的串场', async t => {
  const cancellations: string[] = []
  const { runtime, audio, records } = setup(t, [1, 2, 3, 4, 5], {
    settings: async () => ({ ok: true, settings: { djEnabled: 'true', djIntervalTracks: '3' } }),
    djPrepare: async request => {
      const job = SAMPLES.readyJob()
      Object.assign(job.script!, { transitionId: request.transitionId, targetItemId: request.targetItemId, targetTrackId: request.targetTrackId })
      return { ok: true, job: { ...job, segueId: 'sg-' + request.transitionId } }
    },
    djCancel: async id => { cancellations.push(id); return { ok: true } },
  })
  await runtime.settings.refresh()
  await runtime.playback.play(0); audio.emit('playing'); await flush()
  for (let index = 0; index < 2; index++) {
    audio.emit('ended'); await flush(); audio.emit('playing'); await flush()
  }
  assert.equal(runtime.playback.getSnapshot().currentTrackId, 3)
  audio.currentTime = 10
  runtime.playback.pause()
  const pending = deferred<void>()
  audio.play = () => pending.promise
  const oldResume = runtime.playback.resume()
  audio.play = async () => { audio.paused = false }
  await runtime.playback.play(3); audio.emit('playing'); await flush()
  const before = runtime.segue.snapshot()
  assert.ok(before.ready, 'B 已有独立就绪串场')
  const cancelledBefore = [...cancellations]
  pending.reject(new Error('A resume rejected late'))
  await oldResume
  await flush()
  assert.equal(runtime.playback.getSnapshot().currentTrackId, 4)
  assert.equal(records.at(-1)?.trackId, 4)
  assert.equal(records.at(-1)?.outcome, null)
  assert.equal(audio.paused, false)
  assert.equal(runtime.segue.snapshot().transitionId, before.transitionId)
  assert.deepEqual(runtime.segue.snapshot().ready, before.ready)
  assert.deepEqual(cancellations, cancelledBefore)
})
