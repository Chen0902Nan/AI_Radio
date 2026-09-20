import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { INestApplication } from '@nestjs/common'
import { moveToTrash } from '../lib/trash.mts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-listening-input-'))
process.env.RADIO_DATA_DIR = dir
process.env.RADIO_DB_FILE = path.join(dir, 'radio.db')
process.env.RADIO_SESSION_FILE = path.join(dir, 'session.json')
process.env.DJ_AUDIO_CACHE_DIR = path.join(dir, 'audio')
const require = createRequire(import.meta.url)
require('reflect-metadata')
const { NestFactory }: typeof import('@nestjs/core') = require('@nestjs/core')
const { AppModule }: typeof import('../../apps/api/dist/app.module.js') = require('../../apps/api/dist/app.module.js')
let app: INestApplication
let base = ''
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
async function request(route: string, body?: unknown): Promise<Record<string, unknown> & { status: number }> {
  const response = await fetch(base + '/api/' + route, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value: unknown = await response.json()
  return { status: response.status, ...object(value) }
}
test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false })
  await app.listen(0, '127.0.0.1')
  base = await app.getUrl()
})
test.after(async () => { await app?.close(); moveToTrash(dir) })

test('malformed feedback text returns 400 without revoking the existing feedback', async () => {
  const valid = { trackId: 7101, trackName: '原曲名', artists: '原歌手', sentiment: 'like', source: 'ui' }
  const first = await request('feedback', valid)
  assert.equal(first.status, 200)
  const before = await request('feedback')
  for (const field of ['trackName', 'artists', 'source']) {
    for (const invalid of [{ nested: 'invalid' }, ['invalid']]) {
      const rejected = await request('feedback', { ...valid, sentiment: 'dislike', [field]: invalid })
      assert.equal(rejected.status, 400)
      assert.deepEqual(await request('feedback'), before, `${field} must preserve active feedback`)
      assert.equal(rejected.code, 'invalid_request')
    }
  }
})

test('malformed play metadata returns 400 before creating a session or play record', async () => {
  await request('session/stop', {})
  const beforeHistory = await request('plays/history')
  const beforeSession = await request('session')
  assert.equal(beforeSession.session, null)
  for (const field of ['trackName', 'artists', 'sessionId', 'selectionId', 'playInstanceId']) {
    for (const invalid of [{ nested: 'invalid' }, ['invalid']]) {
      const rejected = await request('plays/start', { trackId: 7102, [field]: invalid })
      assert.equal(rejected.status, 400, `${field} must return a client error`)
      assert.equal(rejected.code, 'invalid_request')
      assert.deepEqual(await request('plays/history'), beforeHistory)
      assert.deepEqual(await request('session'), beforeSession)
    }
  }
})

test('valid feedback still replaces the old choice and retains optional text defaults', async () => {
  const result = await request('feedback', { trackId: '7101', sentiment: 'dislike', trackName: null, artists: null })
  assert.equal(result.status, 200)
  assert.equal(object(result.feedback).sentiment, 'dislike')
  assert.equal(object(result.feedback).source, 'ui')
  assert.equal(object(result.feedback).track_name, null)
  const active = (await request('feedback')).active
  assert.ok(Array.isArray(active))
  assert.equal(active.length, 1)
  const before = await request('feedback')
  assert.equal((await request('feedback', { trackId: 7101, sentiment: { invalid: true } })).status, 400)
  assert.deepEqual(await request('feedback'), before)
})

test('valid play text still starts a session and deduplicates the same play instance', async () => {
  const valid = { trackId: '7103', trackName: '正常曲名', artists: '正常歌手', playInstanceId: 'valid-instance' }
  const first = await request('plays/start', valid)
  assert.equal(first.status, 200)
  assert.equal(typeof object(first.session).id, 'string')
  const duplicate = await request('plays/start', { ...valid, sessionId: object(first.session).id })
  assert.equal(duplicate.playId, first.playId)
  const history = await request('plays/history')
  assert.deepEqual(history.automatic, [])
  assert.ok(Array.isArray(history.recent))
  assert.equal(history.recent.length, 1)
  assert.equal(object(history.recent[0]).track_name, '正常曲名')
  assert.equal(object(history.recent[0]).artists, '正常歌手')
  assert.equal((await request('plays/start', { trackId: 7104, trackName: null, artists: null })).status, 200)
})


test('反馈接口的无名歌曲可由前端合同读取，非法名称仍被拒绝', async () => {
  const { parseFeedback }: typeof import('@radio/contracts') = require('@radio/contracts')
  assert.equal((await request('feedback', { trackId: 7200, sentiment: 'like' })).status, 200)
  const response = await request('feedback')
  const feedback = parseFeedback(response)
  assert.equal(feedback.active.find(row => row.track_id === 7200)?.sentiment, 'like')
  assert.throws(() => parseFeedback({ active: [{ track_id: 7200, track_name: {}, sentiment: 'like' }] }))
})
