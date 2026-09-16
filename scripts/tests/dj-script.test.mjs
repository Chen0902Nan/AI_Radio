import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dj = require('../../server/dj-script.js')
const contract = require('../../public/program-contract.js')
const codex = require('../../server/codex.js')

/* ---------- 提示词 ---------- */

test('提示词包含目标歌曲、归因要求、basic_only 退路与当天日期', () => {
  const prompt = dj.buildSeguePrompt({
    targetName: '灯塔',
    targetArtists: '另一位歌手',
    album: '示例专辑',
    brief: '深夜，安静一点',
    today: '2026-09-17',
  })
  assert.ok(prompt.includes('灯塔'), '应包含歌名')
  assert.ok(prompt.includes('另一位歌手'), '应包含歌手')
  assert.ok(prompt.includes('2026-09-17'), '应注入当天日期作为检索时间')
  assert.ok(prompt.includes('说法'), '应包含民间说法的归因要求')
  assert.ok(prompt.includes('basic_only'), '应包含查无资料的退路')
  assert.ok(prompt.includes('50') && prompt.includes('140'), '应包含字数边界')
})

/* ---------- 搜索活动摘要 ---------- */

test('搜索活动摘要从 JSONL 事件中计数搜索并收集 URL，不假定固定事件结构', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.started', item: { type: 'web_search', query: '灯塔 另一位歌手 创作背景' } }),
    '这不是 JSON 的一行',
    JSON.stringify({ type: 'item.completed', item: { type: 'web_search', action: { type: 'search', query: '灯塔 专辑 录制' } } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'citation', url: 'https://forum.example.com/thread/12345' } }),
  ].join('\n')
  const s = dj.summarizeSearchActivity(stdout)
  assert.equal(s.searchEvents, 2)
  assert.ok(s.urls.includes('https://forum.example.com/thread/12345'))
  assert.ok(s.querySample.includes('灯塔 另一位歌手 创作背景'))
})

test('没有搜索事件时摘要为零，且不抛错', () => {
  const s = dj.summarizeSearchActivity('garbage\n\n{"broken')
  assert.deepEqual(s, { searchEvents: 0, urls: [], querySample: [] })
})

/* ---------- 生成主流程（注入替身，不调用真实模型） ---------- */

const MODEL_SOURCED = () => {
  const s = contract.SAMPLES.sourcedScript()
  return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
}
const MODEL_BASIC = () => {
  const s = contract.SAMPLES.basicOnlyScript()
  return { storyStatus: s.storyStatus, scriptText: s.scriptText, claims: s.claims, sources: s.sources }
}

const INPUT = {
  targetTrackId: 900002,
  targetItemId: 'itn_demo_2',
  transitionId: 'tr_demo_1',
  targetName: '灯塔',
  targetArtists: '另一位歌手',
  brief: '深夜，安静一点',
}

function fakeExec(finalJson, opts = {}) {
  let calls = 0
  return {
    calls: () => calls,
    execFinal: async () => {
      calls += 1
      if (opts.nonzero) return { code: 1, stdout: '', stderr: opts.stderr || 'boom', timedOut: false, finalJson: null }
      if (opts.timedOut) return { code: null, stdout: '', stderr: '', timedOut: true, finalJson: null }
      return { code: 0, stdout: opts.stdout || '', stderr: '', timedOut: false, finalJson }
    },
  }
}

test('成功：成品携带机会身份，通过契约校验，附搜索活动摘要，且只调用一次模型', async () => {
  const fake = fakeExec(MODEL_SOURCED(), { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'q' } }) })
  const res = await dj.generateSegueScript(INPUT, fake)
  assert.equal(res.ok, true, res.message)
  assert.equal(res.script.targetTrackId, 900002)
  assert.equal(res.script.targetItemId, 'itn_demo_2')
  assert.equal(res.script.transitionId, 'tr_demo_1')
  const v = contract.validateScript(res.script, { targetTrackId: 900002, targetItemId: 'itn_demo_2', transitionId: 'tr_demo_1' })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(res.meta.searchActivity.searchEvents, 1)
  assert.equal(fake.calls(), 1, '失败/成功都只调用一次模型，不做无限修稿循环')
})

test('查无资料：basic_only 照常返回，不编造出处', async () => {
  const fake = fakeExec(MODEL_BASIC())
  const res = await dj.generateSegueScript(INPUT, fake)
  assert.equal(res.ok, true)
  assert.equal(res.script.storyStatus, 'basic_only')
  assert.deepEqual(res.script.claims, [])
  assert.deepEqual(res.script.sources, [])
})

test('模型超时/退出码失败/输出非 JSON 都返回可处理失败', async () => {
  const t = await dj.generateSegueScript(INPUT, fakeExec(null, { timedOut: true }))
  assert.equal(t.ok, false)
  assert.equal(t.code, 'timeout')

  const q = await dj.generateSegueScript(INPUT, fakeExec(null, { nonzero: true, stderr: 'usage limit reached 429' }))
  assert.equal(q.ok, false)
  assert.equal(q.code, 'quota')

  const bad = await dj.generateSegueScript(INPUT, fakeExec(null))
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'invalid_output')
})

test('空稿、目标缺失、归因缺失的模型输出被结构校验拒绝', async () => {
  const empty = MODEL_SOURCED()
  empty.scriptText = '   '
  const r1 = await dj.generateSegueScript(INPUT, fakeExec(empty))
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.code === 'empty_script'))

  const noAttr = MODEL_SOURCED()
  noAttr.claims[0].spokenAttribution = ''
  const r2 = await dj.generateSegueScript(INPUT, fakeExec(noAttr))
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.code === 'missing_spoken_attribution'))
})

test('输入不合法（缺歌名/身份）时直接拒绝，不发起模型调用', async () => {
  const fake = fakeExec(MODEL_SOURCED())
  const r1 = await dj.generateSegueScript({ ...INPUT, targetName: '' }, fake)
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'invalid_input')
  const r2 = await dj.generateSegueScript({ ...INPUT, transitionId: '' }, fake)
  assert.equal(r2.ok, false)
  assert.equal(fake.calls(), 0)
})

test('brief 超长被拒绝', async () => {
  const res = await dj.generateSegueScript({ ...INPUT, brief: 'x'.repeat(201) }, fakeExec(MODEL_SOURCED()))
  assert.equal(res.ok, false)
  assert.equal(res.code, 'invalid_input')
})

/* ---------- 测试注入模式（RADIO_TEST_HOOKS=1，供 05/08 服务端联调） ---------- */

test('注入模式：success/basic_only/timeout/quota/invalid 覆盖主要路径', async () => {
  const prevHook = process.env.RADIO_TEST_HOOKS
  process.env.RADIO_TEST_HOOKS = '1'
  try {
    dj.setDjScriptMode('success')
    const a = await dj.generateSegueScript(INPUT)
    assert.equal(a.ok, true)
    assert.equal(a.meta.injected, true)

    dj.setDjScriptMode('basic_only')
    const b = await dj.generateSegueScript(INPUT)
    assert.equal(b.ok, true)
    assert.equal(b.script.storyStatus, 'basic_only')

    dj.setDjScriptMode('timeout')
    const t = await dj.generateSegueScript(INPUT)
    assert.equal(t.ok, false)
    assert.equal(t.code, 'timeout')

    dj.setDjScriptMode('quota')
    const q = await dj.generateSegueScript(INPUT)
    assert.equal(q.ok, false)
    assert.equal(q.code, 'quota')

    dj.setDjScriptMode('invalid')
    const i = await dj.generateSegueScript(INPUT)
    assert.equal(i.ok, false)
    assert.equal(i.code, 'invalid_output')
  } finally {
    dj.setDjScriptMode('off')
    if (prevHook === undefined) delete process.env.RADIO_TEST_HOOKS
    else process.env.RADIO_TEST_HOOKS = prevHook
  }
})

/* ---------- 旧选歌行为不回归 ---------- */

test('codex.js 既有选歌校验保持原行为（fabricated id 拒绝、真实候选保留）', () => {
  const candidates = [{ id: 1, name: 'A', reason: '' }, { id: 2, name: 'B', reason: '' }]
  const raw = { picks: [{ id: 1, reason: 'r1' }, { id: 999, reason: '编造' }, { id: 1, reason: '重复' }] }
  const v = codex.validatePicks(raw, candidates)
  assert.equal(v.valid.length, 1)
  assert.equal(v.valid[0].id, 1)
  assert.equal(v.rejected.length, 2)
  const empty = codex.validatePicks({ picks: [] }, candidates)
  assert.equal(empty.valid.length, 0)
})
