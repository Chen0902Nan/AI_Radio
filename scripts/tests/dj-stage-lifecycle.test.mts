import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { makeDeps, REQ, SCRIPT_OK, FISH_OK, deferred, flush } from './support/dj-pipeline-fixture.mts'
const require = createRequire(import.meta.url)
const { createDjPipeline }: typeof import('../../apps/api/dist/dj/pipeline.js') = require('../../apps/api/dist/dj/pipeline.js')

test('文案返回与合成启动之间停止会话，不调用后续 Fish 供应商', async t => {
  const script = deferred<Record<string, unknown>>()
  const fixture = makeDeps({ djScript: { generateSegueScript: () => script.promise } })
  const pipeline = createDjPipeline(fixture.deps)
  t.after(() => { pipeline._dispose(); fixture.cleanup() })
  const result = await pipeline.prepare(REQ())
  assert.equal(result.ok, true)
  const response = SCRIPT_OK()
  Object.assign(response.script, { transitionId: REQ().transitionId, targetItemId: REQ().targetItemId, targetTrackId: REQ().targetTrackId })
  script.resolve(response)
  // research 的 continuation 已入队；其返回后、外层 runner 恢复前停止。
  queueMicrotask(() => pipeline.invalidateSession(REQ().sessionId))
  await flush()
  assert.equal(fixture.fishCalls.length, 0)
})


test('合成返回与发布之间停止会话，不再写入或发布旧成品', async t => {
  const synth = deferred<Awaited<ReturnType<import('../../apps/api/dist/dj/fish.service.js').FishService['synthesize']>>>()
  const fixture = makeDeps()
  fixture.deps.fish.synthesize = () => synth.promise
  let writes = 0
  const put = fixture.deps.cache.put.bind(fixture.deps.cache)
  fixture.deps.cache.put = input => { writes++; return put(input) }
  const pipeline = createDjPipeline(fixture.deps)
  t.after(() => { pipeline._dispose(); fixture.cleanup() })
  const result = await pipeline.prepare(REQ())
  assert.equal(result.ok, true)
  const response = SCRIPT_OK()
  Object.assign(response.script, { transitionId: REQ().transitionId, targetItemId: REQ().targetItemId, targetTrackId: REQ().targetTrackId })
  fixture.scriptDefers[0].resolve(response)
  await flush()
  synth.resolve(FISH_OK())
  queueMicrotask(() => pipeline.invalidateSession(REQ().sessionId))
  await flush()
  assert.equal(writes, 0)
  assert.equal(pipeline.stats().ready, 0)
})
