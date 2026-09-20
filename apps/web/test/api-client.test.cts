import type { TestContext } from 'node:test'
const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
require('./support/runtime.cts')
const { api }: typeof import('../dist-playback/api/client.js') = require('../src/api/client.ts')

function respond(t: TestContext, body: unknown, status = 200) {
  const original = global.fetch
  global.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  t.after(() => { global.fetch = original })
}

test('非法 2xx 音源响应返回 invalid_response，不承诺可播放', async t => {
  respond(t, { playable: true, audioUrl: 123 })
  const result = await api.resolve(1)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

test('畸形 JSON 不能伪装正常空数据', async t => {
  const original = global.fetch
  global.fetch = async () => new Response('<html>broken</html>', { status: 200 })
  t.after(() => { global.fetch = original })
  const result = await api.settings()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

for (const [name, request, payload] of [
  ['library', () => api.library(), { liked: { count: 1, tracks: [{ id: 1 }] }, playlists: { created: [], collected: [], total: 0 } }],
  ['playlist', () => api.playlist(1), { tracks: 'bad' }],
  ['settings', () => api.settings(), { settings: { djEnabled: {} } }],
  ['session', () => api.session(), { session: { id: 23 } }],
  ['feedback', () => api.feedback(), { active: [{ track_id: 1, sentiment: 'unknown' }] }],
  ['plan', () => api.plan({ brief: '', count: 1 }), { picks: [{ id: '1', name: 'bad' }] }],
  ['job', () => api.djJob('1'), { job: { segueId: '1', state: 'ready' } }],
  ['preview', () => api.djPreview('voice'), { audio: { url: 12, durationMs: 1000 } }],
] as const) {
  test(`${name} 的不完整或错误类型响应被 API 边界拒绝`, async t => {
    respond(t, payload)
    const result = await request()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_response')
  })
}

test('正常音源通过，HTTP 错误保留原错误码', async t => {
  respond(t, { playable: true, audioUrl: '/api/audio/1' })
  assert.equal((await api.resolve(1)).ok, true)
  global.fetch = async () => new Response(JSON.stringify({ code: 'trial_only', message: '试听' }), { status: 409 })
  assert.equal((await api.resolve(1)).code, 'trial_only')
})

for (const ok of ['false', 0, null, {}, []]) test(`2xx success marker must be boolean: ${JSON.stringify(ok)}`, async t => {
  respond(t, { ok, settings: { djEnabled: 'true' } })
  const result = await api.settings()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

for (const [field, value] of [
  ['highest_epoch', 1.5], ['highest_epoch', Number.MAX_SAFE_INTEGER + 1], ['highest_epoch', -1],
  ['transition_seq', 0.5], ['transition_seq', Number.MAX_SAFE_INTEGER + 1], ['transition_seq', -2],
] as const) test(`session order rejects invalid ${field}: ${value}`, async t => {
  respond(t, { ok: true, session: { id: 'session', adjustments: {}, highest_epoch: 0, transition_seq: -1, [field]: value } })
  const result = await api.session()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

test('nullable preparing DJ job matches the real HTTP controller response', async t => {
  respond(t, { ok: true, job: { segueId: 'job', state: 'preparing', reason: null, message: null, code: null, script: null, audio: null } })
  const result = await api.djJob('job')
  assert.equal(result.ok, true)
  assert.equal(result.job.state, 'preparing')
  assert.equal(result.job.code, undefined)
})

test('empty DJ identity is invalid even when the state is preparing', async t => {
  respond(t, { ok: true, job: { segueId: '', state: 'preparing' } })
  const result = await api.djJob('job')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

test('ready DJ audio preserves the validated asset identity and byte size', async t => {
  const { SAMPLES }: typeof import('@radio/contracts') = require('@radio/contracts')
  const job = SAMPLES.readyJob()
  respond(t, { ok: true, job })
  const result = await api.djJob(job.segueId)
  assert.equal(result.ok, true)
  assert.deepEqual(result.job.audio, job.audio)
})

test('missing library account is malformed, while explicit null remains valid', async t => {
  const library = { liked: { count: 0, tracks: [] }, playlists: { created: [], collected: [], total: 0 } }
  respond(t, library)
  const missing = await api.library()
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'invalid_response')
  global.fetch = async () => new Response(JSON.stringify({ ...library, account: null }))
  assert.equal((await api.library()).ok, true)
})

for (const field of ['highest_epoch', 'transition_seq'] as const) test(`explicit null ${field} cannot use the legacy default`, async t => {
  respond(t, { ok: true, session: { id: 's', [field]: null } })
  const result = await api.session()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})

test('legacy session order fields normalize to numeric initialization values', async t => {
  respond(t, { ok: true, session: { id: 's' } })
  const result = await api.session()
  assert.equal(result.ok, true)
  assert.equal(result.session?.highest_epoch, 0)
  assert.equal(result.session?.transition_seq, -1)
})

for (const patch of [{ assetId: undefined }, { bytes: undefined }, { bytes: '100' }, { url: 'https://example.com/voice.mp3' }]) test(`DJ ready audio rejects incomplete or invalid metadata ${JSON.stringify(patch)}`, async t => {
  const { SAMPLES }: typeof import('@radio/contracts') = require('@radio/contracts')
  const job = SAMPLES.readyJob()
  respond(t, { ok: true, job: { ...job, audio: { ...job.audio, ...patch } } })
  const result = await api.djJob(job.segueId)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_response')
})
