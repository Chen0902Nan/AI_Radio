const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const { setup, flush, deferredFor }: import('./support/runtime.cjs').RuntimeSupport = require('./support/runtime.cts')

function installEvents(t: import('node:test').TestContext) {
  class Events {
    listeners = new Map<string, () => void>()
    addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener) }
    close() {}
    open() { this.listeners.get('open')?.() }
  }
  const previous = global.EventSource
  const events = new Events()
  // 仅替换浏览器构造边界，fixture 不实现未被运行时使用的 EventSource 常量/属性。
  global.EventSource = class { constructor() { return events } } as unknown as typeof EventSource
  t.after(() => { global.EventSource = previous })
  return events
}

test('设置统一入口同步补歌阈值与退避配置，不打断当前媒体', async t => {
  const { runtime, audio } = setup(t, [1, 2], {
    settings: async () => ({ ok: true, settings: { djEnabled: 'false', refillThreshold: '1', refillBatchSize: '3', refillBackoffBaseMs: '1000', refillMaxAttempts: '3' } }),
  })
  await runtime.playback.play(0)
  const source = audio.src
  await runtime.settings.refresh()
  assert.equal(runtime.refill.config.threshold, 1)
  assert.equal(runtime.refill.config.batchSize, 3)
  assert.equal(runtime.refill.config.backoffBaseMs, 1000)
  assert.equal(runtime.refill.config.maxAttempts, 3)
  assert.equal(audio.src, source)
  assert.equal(audio.paused, false)
})

test('页面重连恢复开放会话的持久版本，但不自动出声', async t => {
  const events = installEvents(t)
  const watermark = Date.now() + 1000000
  const { runtime, audio } = setup(t, [1, 2], {
    session: async () => ({ ok: true, session: { id: 'open-session', highest_epoch: watermark, transition_seq: 14, adjustments: {} } }),
  })
  const release = runtime.connect()
  t.after(release)
  events.open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.store.get().sessionId, 'open-session')
  assert.ok(runtime.refill.epoch > watermark)
  assert.equal(runtime.segue.snapshot().epoch, runtime.refill.epoch)
  assert.equal(audio.paused, true)
  assert.equal(runtime.playback.getSnapshot().userWantsPlayback, false)
})


test('停止后迟到的开放会话快照不得恢复收听意图', async t => {
  const events = installEvents(t)
  const pending = deferredFor('session')
  const { runtime, audio } = setup(t, [1, 2], { session: () => pending.promise })
  const release = runtime.connect()
  t.after(release)
  events.open()
  await runtime.stopListening()
  pending.resolve({ ok: true, session: { id: 'obsolete', highest_epoch: Date.now(), transition_seq: 1, adjustments: {} } })
  await flush()
  assert.equal(runtime.store.get().sessionId, null)
  assert.equal(runtime.playback.getSnapshot().userWantsPlayback, false)
  assert.equal(audio.paused, true)
})

test('停止后重新开播失败，停止前的旧快照仍不能恢复旧会话', async t => {
  const events = installEvents(t)
  const pending = deferredFor('session')
  const { runtime } = setup(t, [1, 2], {
    session: () => pending.promise,
    sessionStart: async () => ({ ok: false, message: 'offline' }),
  })
  const release = runtime.connect()
  t.after(release)
  events.open()
  await runtime.stopListening()
  await runtime.startListening()
  pending.resolve({ ok: true, session: { id: 'stopped-session', highest_epoch: Date.now(), transition_seq: 1, adjustments: {} } })
  await flush()
  assert.equal(runtime.store.get().sessionId, null)
  assert.equal(runtime.playback.getSnapshot().userWantsPlayback, false)
})
