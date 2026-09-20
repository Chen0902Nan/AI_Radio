const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
require('./support/runtime.cts')
const { DjSettingsController }: typeof import('../dist-playback/orchestration/dj-settings.js') = require('../src/orchestration/dj-settings.ts')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('关闭 DJ 后旧读取不能重新开启；生效配置与公开快照一致', async () => {
  const read = deferred<{ ok: boolean; settings: Record<string, string> }>()
  const applied: boolean[] = []
  const settings = new DjSettingsController({
    read: () => read.promise,
    save: async () => ({ ok: true }),
    apply: config => { applied.push(config.djEnabled) },
  })
  const loading = settings.refresh()
  await settings.save('djEnabled', 'false')
  read.resolve({ ok: true, settings: { djEnabled: 'true' } })
  await loading
  assert.equal(settings.getSnapshot().settings.djEnabled, 'false')
  assert.equal(applied.at(-1), false)
})

test('连续保存按序到服务端；SSE 读取等待所有保存结束并恢复失败设置', async () => {
  const first = deferred<{ ok: boolean }>()
  const second = deferred<{ ok: boolean; message: string }>()
  const writes: string[] = []
  let reads = 0
  const settings = new DjSettingsController({
    read: async () => { reads++; return { ok: true, settings: { djEnabled: 'false' } } },
    save: (_key, value) => { writes.push(value); return writes.length === 1 ? first.promise : second.promise },
    apply: () => {},
  })
  const a = settings.save('djEnabled', 'false')
  const b = settings.save('djEnabled', 'true')
  await settings.refresh()
  assert.deepEqual(writes, ['false'])
  assert.equal(reads, 0)
  first.resolve({ ok: true })
  assert.equal(await a, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, ['false', 'true'])
  second.resolve({ ok: false, message: 'fixture failure' })
  assert.equal(await b, false)
  assert.equal(settings.getSnapshot().settings.djEnabled, 'false')
  assert.match(settings.getSnapshot().error!, /fixture failure/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
})

test('新 SSE 读取先返回时旧读取不能回滚已同步配置', async () => {
  const old = deferred<{ ok: boolean; settings: Record<string, string> }>()
  let reads = 0
  const settings = new DjSettingsController({
    read: () => ++reads === 1 ? old.promise : Promise.resolve({ ok: true, settings: { djIntervalTracks: '5' } }),
    save: async () => ({ ok: true }), apply: () => {},
  })
  const a = settings.refresh()
  await settings.refresh()
  old.resolve({ ok: true, settings: { djIntervalTracks: '3' } })
  await a
  assert.equal(settings.getSnapshot().settings.djIntervalTracks, '5')
})
