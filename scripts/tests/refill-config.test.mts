import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { RefillController, REFILL_DEFAULTS }: typeof import('../../apps/web/dist-playback/orchestration/refill-controller.js') = require('../../apps/web/dist-playback/orchestration/refill-controller.cjs')

test('补歌配置只接受已知字段的有限非负整数，非法值不覆盖已确认配置', () => {
  const controller = new RefillController()
  const initial = controller.setConfig({ batchSize: '7', threshold: '0' })
  for (const invalid of [Infinity, 'Infinity', -1, 'NaN', {}, [], true, 1.5, '']) {
    assert.deepEqual(controller.setConfig({ batchSize: invalid, threshold: invalid, maxAttempts: invalid, backoffBaseMs: invalid }), initial)
  }
  assert.deepEqual(controller.setConfig({ mystery: 9, batchSize: 0, maxAttempts: 0 }), initial)
  assert.deepEqual(controller.setConfig({ backoffBaseMs: '0', backoffMaxMs: '100', maxAttempts: '3' }), { ...initial, backoffBaseMs: 0, backoffMaxMs: 100, maxAttempts: 3 })
  controller.cancel()
})

test('构造时配置与后续设置使用相同约束', () => {
  const controller = new RefillController({ config: { batchSize: Infinity, threshold: -1 } })
  assert.deepEqual(controller.config, REFILL_DEFAULTS)
  controller.cancel()
})
