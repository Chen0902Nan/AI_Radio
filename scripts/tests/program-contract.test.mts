import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// 迁移后测试目标：packages/contracts 的 TS 实现（原 public/program-contract.js）
const require = createRequire(import.meta.url)
const c: typeof import('@radio/contracts') = require('@radio/contracts')

/* ---------- 工具 ---------- */

function errors(res: { errors?: Array<{ code: string }>; ok?: unknown; value?: unknown }) {
  return (res.errors || []).map((e: { code: string }) => e.code)
}
function hasCode(res: Parameters<typeof errors>[0], code: string) {
  return errors(res).includes(code)
}
function assertRejected(res: { ok: unknown; value?: unknown }, code: string) {
  assert.equal(res.ok, false, `应当拒绝，实际通过：${JSON.stringify(res.value || res)}`)
  if (code) assert.ok(hasCode(res, code), `应含错误码 ${code}，实际：${errors(res).join(',')}`)
}
function assertAccepted(res: { ok: unknown }) {
  assert.equal(res.ok, true, `应当通过，实际错误：${errors(res).join(',')}`)
}

/* ---------- 1. 身份与节目条目 ---------- */

test('同一 trackId 两次入队得到不同 itemId，trackId 保持一致', () => {
  const a = c.makeTrackItem({ id: 123, name: '夜航西飞', artists: '示例歌手' })
  const b = c.makeTrackItem({ id: 123, name: '夜航西飞', artists: '示例歌手' })
  assert.notEqual(a.itemId, b.itemId)
  assert.equal(a.trackId, 123)
  assert.equal(b.trackId, 123)
  assert.equal(a.type, 'track')
})

test('旧歌曲对象经适配后不再携带数字 id，播报条目也不伪装成歌曲数字 ID', () => {
  const item = c.makeTrackItem({ id: 123, name: '夜航西飞' })
  assert.equal('id' in item, false)
  const segue = c.makeSegueItem({ segueId: 'sg_x', transitionId: 'tr_x', targetTrackId: 123 })
  assert.equal('id' in segue, false)
  assert.equal(segue.type, 'segue')
})

test('validateQueueItem 接受合法歌曲与播报条目，拒绝旧结构与伪装条目', () => {
  assertAccepted(c.validateQueueItem(c.makeTrackItem({ id: 1, name: 'A' })))
  assertAccepted(c.validateQueueItem(c.makeSegueItem({ segueId: 'sg_x' })))
  assertRejected(c.validateQueueItem({ id: 5, name: '旧结构' }), 'legacy_track_shape')
  assertRejected(c.validateQueueItem({ type: 'track', itemId: 'x' }), 'invalid_track_id')
  assertRejected(c.validateQueueItem({ type: 'episode', itemId: 'x' }), 'invalid_program_type')
  assertRejected(
    c.validateQueueItem({ type: 'segue', itemId: 'x', segueId: 'sg', id: 42 }),
    'segue_masquerades_track_id',
  )
  assertRejected(c.validateQueueItem({ type: 'track', itemId: '' , trackId: 1 }), 'missing_item_id')
})

/* ---------- 2. 串场机会（transition） ---------- */

test('同一 (sessionId, epoch, transitionId) 得到相同机会键，跨 epoch 不同', () => {
  const t = c.makeTransition({ sessionId: 's1', epoch: 7, fromItemId: 'a', targetItemId: 'b', targetTrackId: 9 })
  assert.equal(c.transitionKey(t), c.transitionKey({ sessionId: 's1', epoch: 7, transitionId: t.transitionId }))
  assert.notEqual(c.transitionKey(t), c.transitionKey({ ...t, epoch: 8 }))
})

test('机会可以关闭且幂等；关闭后不再是 open', () => {
  const t = c.makeTransition({ sessionId: 's1', epoch: 1, fromItemId: 'a', targetItemId: 'b', targetTrackId: 9 })
  assert.equal(c.isTransitionOpen(t), true)
  const closed = c.closeTransition(t, 'superseded')
  assert.equal(c.isTransitionOpen(closed), false)
  assert.equal(closed.closedReason, 'superseded')
  assert.equal(c.closeTransition(closed, 'again'), closed)
})

test('validateTransition 拒绝缺身份字段与非法状态', () => {
  const t = c.makeTransition({ sessionId: 's1', epoch: 1, fromItemId: 'a', targetItemId: 'b', targetTrackId: 9 })
  assertAccepted(c.validateTransition(t))
  assertRejected(c.validateTransition({ ...t, targetItemId: 'a' }), 'same_from_and_target')
  assertRejected(c.validateTransition({ ...t, sessionId: '' }), 'missing_session_id')
  assertRejected(c.validateTransition({ ...t, targetTrackId: 'abc' }), 'invalid_target_track_id')
})

/* ---------- 3. 准备请求 ---------- */

test('合法准备请求通过并归一化目标歌曲 id', () => {
  const res = c.validatePrepareRequest(c.SAMPLES.prepareRequest())
  assertAccepted(res)
  assert.equal(res.value!.targetTrackId, 900002)
})

test('准备请求保留目标歌名与歌手：生成器靠它们搜索和写稿，不能在校验时丢掉', () => {
  const res = c.validatePrepareRequest({ ...c.SAMPLES.prepareRequest(), targetName: '晴天', targetArtists: '周杰伦' })
  assertAccepted(res)
  assert.equal(res.value!.targetName, '晴天')
  assert.equal(res.value!.targetArtists, '周杰伦')
  // 未提供时归一化为空串，调用方拿到的是稳定形状而不是 undefined
  const none = c.validatePrepareRequest(c.SAMPLES.prepareRequest())
  assertAccepted(none)
  assert.equal(none.value!.targetName, '')
  assert.equal(none.value!.targetArtists, '')
})

test('准备请求缺少会话/机会身份或目标等于来源时被拒绝', () => {
  const base = () => c.SAMPLES.prepareRequest()
  assertRejected(c.validatePrepareRequest({ ...base(), sessionId: '' }), 'missing_session_id')
  assertRejected(c.validatePrepareRequest({ ...base(), transitionId: '' }), 'missing_transition_id')
  assertRejected(c.validatePrepareRequest({ ...base(), targetItemId: base().fromItemId }), 'same_from_and_target')
  assertRejected(c.validatePrepareRequest({ ...base(), targetTrackId: 'x' }), 'invalid_target_track_id')
  assertRejected(c.validatePrepareRequest({ ...base(), epoch: 'nan' }), 'invalid_epoch')
  assertRejected(c.validatePrepareRequest({ ...base(), brief: 'x'.repeat(201) }), 'brief_too_long')
})

test('同一机会键但不同目标的准备请求不能复用同一任务', () => {
  const job = c.SAMPLES.preparingJob()
  const same = c.jobMatchesPrepare(job, c.SAMPLES.prepareRequest())
  assert.equal(same.match, true)
  const otherTarget = c.jobMatchesPrepare(job, { ...c.SAMPLES.prepareRequest(), targetItemId: 'itn_other' })
  assert.equal(otherTarget.match, false)
  assert.equal(otherTarget.reason, 'target_item_mismatch')
  const otherEpoch = c.jobMatchesPrepare(job, { ...c.SAMPLES.prepareRequest(), epoch: 99 })
  assert.equal(otherEpoch.match, false)
})

/* ---------- 4. 文案成品与来源 ---------- */

test('带出处与民间说法归因的文案通过校验', () => {
  const res = c.validateScript(c.SAMPLES.sourcedScript())
  assertAccepted(res)
  assert.deepEqual(res.deviations, [])
})

test('空稿、非法 storyStatus、非法 claim kind 被拒绝', () => {
  assertRejected(c.validateScript({ ...c.SAMPLES.sourcedScript(), scriptText: '   ' }), 'empty_script')
  assertRejected(c.validateScript({ ...c.SAMPLES.sourcedScript(), storyStatus: 'rumor' }), 'invalid_story_status')
  const badKind = c.SAMPLES.sourcedScript()
  const malformed = { ...badKind, claims: [{ ...badKind.claims[0], kind: 'rumor' }] }
  assertRejected(c.validateScript(malformed), 'invalid_claim_kind')
})

test('跨目标文案被拒绝（机会身份不匹配）', () => {
  // 目标一致时通过
  assertAccepted(c.validateScript(c.SAMPLES.sourcedScript(), { targetTrackId: 900002 }))
  assertRejected(
    c.validateScript(c.SAMPLES.sourcedScript(), { targetTrackId: 777777 }),
    'target_mismatch',
  )
  assertRejected(
    c.validateScript(c.SAMPLES.sourcedScript(), { transitionId: 'tr_other' }),
    'transition_mismatch',
  )
  assertRejected(
    c.validateScript(c.SAMPLES.sourcedScript(), { targetItemId: 'itn_other' }),
    'target_mismatch',
  )
})

test('缺失来源引用与不存在的 sourceId 被拒绝', () => {
  const s = c.SAMPLES.sourcedScript()
  s.claims[0].sourceIds = ['s999']
  assertRejected(c.validateScript(s), 'missing_source_reference')
  const noRef = c.SAMPLES.sourcedScript()
  noRef.claims[0].sourceIds = []
  assertRejected(c.validateScript(noRef), 'claim_without_source')
  assertRejected(c.validateScript({ ...c.SAMPLES.sourcedScript(), claims: [] }), 'no_claims')
  assertRejected(c.validateScript({ ...c.SAMPLES.sourcedScript(), sources: [] }), 'no_sources')
})

test('unverified_account 必须在播报文字里保留归因，元数据标记不算', () => {
  const missing = c.SAMPLES.sourcedScript()
  missing.claims[0].spokenAttribution = ''
  assertRejected(c.validateScript(missing), 'missing_spoken_attribution')
  const notInText = c.SAMPLES.sourcedScript()
  notInText.claims[0].spokenAttribution = '据权威机构证实'
  assertRejected(c.validateScript(notInText), 'attribution_missing_in_script')
  // documented 允许没有播出归因
  const documented = c.SAMPLES.sourcedScript()
  documented.claims[1].spokenAttribution = ''
  assertAccepted(c.validateScript(documented))
})

test('来源允许论坛/个人页面，无白名单；非法 URL、重复 id、过长摘录被拒绝', () => {
  assertAccepted(c.validateSources(c.SAMPLES.sourcedScript().sources))
  const bad = c.SAMPLES.sourcedScript()
  bad.sources[0].url = 'ftp://forum.example.com/x'
  assertRejected(c.validateScript(bad), 'invalid_source_url')
  const dup = c.SAMPLES.sourcedScript()
  dup.sources[1].id = 's1'
  assertRejected(c.validateScript(dup), 'duplicate_source_id')
  const longEv = c.SAMPLES.sourcedScript()
  longEv.sources[0].evidence = '长'.repeat(401)
  assertRejected(c.validateScript(longEv), 'evidence_too_long')
  const noTime = c.SAMPLES.sourcedScript()
  noTime.sources[0].retrievedAt = 'not-a-date'
  assertRejected(c.validateScript(noTime), 'invalid_retrieved_at')
})

test('basic_only 只允许歌名/歌手与氛围，不得携带陈述和来源；短稿记录偏差', () => {
  const res = c.validateScript(c.SAMPLES.basicOnlyScript())
  assertAccepted(res)
  assert.equal(res.deviations.length, 1)
  assert.equal(res.deviations[0].code, 'short_basic_intro')
  assertRejected(
    c.validateScript({ ...c.SAMPLES.basicOnlyScript(), claims: c.SAMPLES.sourcedScript().claims }),
    'basic_only_with_claims',
  )
  assertRejected(
    c.validateScript({ ...c.SAMPLES.basicOnlyScript(), sources: c.SAMPLES.sourcedScript().sources }),
    'basic_only_with_sources',
  )
})

test('超长稿被拒绝', () => {
  const long = c.SAMPLES.sourcedScript()
  long.scriptText = '长'.repeat(141)
  long.claims[0].spokenAttribution = '长'
  assertRejected(c.validateScript(long), 'script_too_long')
})

/* ---------- 5. 任务（job）状态 ---------- */

test('合法的 preparing/ready/unavailable/stale 任务通过校验', () => {
  assertAccepted(c.validateSegueJob(c.SAMPLES.preparingJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.readyJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.unavailableJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.staleJob()))
})

test('ready 任务缺音频、外部音频地址、非法时长、超 30 秒均被拒绝', () => {
  assertRejected(c.validateSegueJob({ ...c.SAMPLES.readyJob(), audio: undefined }), 'missing_audio')
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.readyJob(), audio: { assetId: 'a', url: 'https://cdn.example.com/x.mp3', durationMs: 20000 } }),
    'invalid_audio_url',
  )
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 0 } }),
    'invalid_audio_duration',
  )
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.readyJob(), audio: { assetId: 'a', url: '/api/dj/audio/a', durationMs: 31000 } }),
    'audio_too_long',
  )
})

test('ready 任务与目标不符（跨目标成品）被拒绝', () => {
  const job = c.SAMPLES.readyJob()
  job.script.targetTrackId = 777777
  assertRejected(c.validateSegueJob(job), 'target_mismatch')
})

test('preparing 不能提前携带成品；unavailable/stale 的原因必须在枚举内', () => {
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.preparingJob(), audio: c.SAMPLES.readyJob().audio }),
    'premature_result',
  )
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.unavailableJob(), reason: 'whatever' }),
    'invalid_unavailable_reason',
  )
  assertRejected(
    c.validateSegueJob({ ...c.SAMPLES.staleJob(), reason: 'whatever' }),
    'invalid_stale_reason',
  )
  assertRejected(c.validateSegueJob({ ...c.SAMPLES.preparingJob(), state: 'done' }), 'invalid_job_state')
})

test('任务属于其他会话/旧 epoch/已关闭机会时按当前机会核对被拒绝', () => {
  assertRejected(
    c.validateSegueJob(c.SAMPLES.readyJob(), { sessionId: 'other-session' }),
    'session_mismatch',
  )
  assertRejected(c.validateSegueJob(c.SAMPLES.readyJob(), { epoch: 999 }), 'epoch_mismatch')
  assertRejected(
    c.validateSegueJob(c.SAMPLES.readyJob(), { transitionId: 'tr_other' }),
    'transition_mismatch',
  )
})

/* ---------- 6. 事件与决定形状 ---------- */

test('播放事件需要媒体身份；自然结束必须带 natural 标记', () => {
  assertAccepted(
    c.validateEvent({ type: 'track-ended', itemId: 'itn_1', playInstanceId: 'pi_1', natural: true, at: 1 }),
  )
  assertRejected(
    c.validateEvent({ type: 'track-ended', itemId: 'itn_1', playInstanceId: 'pi_1', at: 1 }),
    'missing_natural_flag',
  )
  assertRejected(c.validateEvent({ type: 'track-ended', itemId: 'itn_1', natural: true, at: 1 }), 'missing_play_instance_id')
  assertRejected(c.validateEvent({ type: 'dance', at: 1 }), 'invalid_event_type')
  assertRejected(
    c.validateEvent({ type: 'segue-ended', itemId: 'itn_dj', playInstanceId: 'pi_2', at: 1 }),
    'missing_segue_id',
  )
  assertAccepted(
    c.validateEvent({ type: 'prepare-result', segueId: 'sg_1', transitionId: 'tr_1', state: 'ready', at: 1 }),
  )
  assertRejected(
    c.validateEvent({ type: 'prepare-result', segueId: 'sg_1', state: 'ready', at: 1 }),
    'missing_transition_id',
  )
})

test('决定类型在契约枚举内', () => {
  assertAccepted(c.validateDecision({ type: 'play-segue', segueId: 'sg_1', at: 1 }))
  assertAccepted(c.validateDecision({ type: 'continue-track', at: 1 }))
  assertRejected(c.validateDecision({ type: 'explode', at: 1 }), 'invalid_decision_type')
})

/* ---------- 7. 播放实例（playInstanceId） ---------- */

test('重新开始同一条目新建播放实例；暂停恢复复用实例', () => {
  const tracker = c.createPlayInstanceTracker()
  const first = tracker.begin('itn_1')
  const resumed = tracker.resume('itn_1')
  assert.equal(first, resumed)
  const restarted = tracker.begin('itn_1')
  assert.notEqual(first, restarted)
  assert.equal(tracker.resume('itn_1'), restarted)
})

test('ended 与首次 playing 各只生效一次；旧实例的回调失效', () => {
  const tracker = c.createPlayInstanceTracker()
  const pi = tracker.begin('itn_1')
  assert.equal(tracker.markEnded(pi), true)
  assert.equal(tracker.markEnded(pi), false)
  const pi2 = tracker.begin('itn_1')
  assert.equal(tracker.markEnded(pi), false) // 旧实例已被替换
  assert.equal(tracker.markPlaying(pi2), true)
  assert.equal(tracker.markPlaying(pi2), false) // 暂停恢复后的第二次 playing 不再是首次
  tracker.clear()
  const pi3 = tracker.resume('itn_1')
  assert.notEqual(pi3, pi2)
})

/* ---------- 8. 时长估算 ---------- */

test('时长估算：60 个汉字约 15 秒，空稿为 0', () => {
  const secs = c.estimateSpeechSeconds('汉'.repeat(60))
  assert.ok(Math.abs(secs - 15) < 0.01, `60 汉字估算 ${secs} 秒`)
  assert.equal(c.estimateSpeechSeconds(''), 0)
})

/* ---------- 9. 样例自检：02–06 可直接使用 ---------- */

test('全部有效样例通过对应校验器', () => {
  assertAccepted(c.validatePrepareRequest(c.SAMPLES.prepareRequest()))
  assertAccepted(c.validateTransition(c.SAMPLES.transition()))
  assertAccepted(c.validateScript(c.SAMPLES.sourcedScript()))
  assertAccepted(c.validateScript(c.SAMPLES.basicOnlyScript()))
  assertAccepted(c.validateQueueItem(c.SAMPLES.trackItem()))
  assertAccepted(c.validateQueueItem(c.SAMPLES.segueItem()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.preparingJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.readyJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.unavailableJob()))
  assertAccepted(c.validateSegueJob(c.SAMPLES.staleJob()))
})

test('全部失败样例以预期错误码被拒绝', () => {
  const dispatch: Record<string, (value: unknown) => import('@radio/contracts').ValidationResult<unknown>> = {
    script: (v: unknown) => c.validateScript(v),
    prepare: (v: unknown) => c.validatePrepareRequest(v),
    job: (v: unknown) => c.validateSegueJob(v),
    sources: (v: unknown) => c.validateSources(v),
  }
  for (const sample of c.SAMPLES.invalidSamples()) {
    const res = dispatch[sample.kind](sample.value)
    assert.equal(
      res.ok,
      false,
      `失败样例 ${sample.name} 不应通过校验`,
    )
    assert.ok(
      hasCode(res, sample.expectCode),
      `失败样例 ${sample.name} 应含 ${sample.expectCode}，实际：${errors(res).join(',')}`,
    )
  }
})

test('校验成功的队列条目具有声明的实际类型，不透传数字字符串或缺失默认字段', () => {
  const result = c.validateQueueItem({ itemId: 'typed', type: 'track', trackId: '123', durationMs: '2000' })
  assert.equal(result.ok, true)
  assert.ok(result.value?.type === 'track')
  assert.equal(result.value.trackId, 123)
  assert.equal(result.value.durationMs, 2000)
  assert.equal(typeof result.value.name, 'string')
  assert.equal(typeof result.value.auto, 'boolean')
  assert.equal(typeof result.value.addedAt, 'number')
})

test('准备请求必须提供安全整数 epoch 和 transitionSeq，不接受缺字段或转换后的伪数字', () => {
  for (const patch of [{ transitionSeq: undefined }, { transitionSeq: '1' }, { transitionSeq: -1 }, { epoch: null }, { epoch: true }, { epoch: Infinity }]) {
    assert.equal(c.validatePrepareRequest({ ...c.SAMPLES.prepareRequest(), ...patch }).ok, false)
  }
})

test('校验成功的机会和成品不泄漏错误的嵌套字段类型', () => {
  assertRejected(c.validateTransition({ ...c.SAMPLES.transition(), closedReason: 42 }), 'invalid_closed_reason')
  assertRejected(c.validateTransition({ ...c.SAMPLES.transition(), closedAt: '123' }), 'invalid_closed_at')
  const script = c.validateScript({ ...c.SAMPLES.sourcedScript(), targetTrackId: '900002' })
  assert.equal(script.ok, true)
  assert.equal(typeof script.value?.targetTrackId, 'number')
  const job = c.SAMPLES.readyJob()
  assertRejected(c.validateSegueJob({ ...job, audio: { ...job.audio, bytes: '50000' } }), 'invalid_audio_bytes')
})
