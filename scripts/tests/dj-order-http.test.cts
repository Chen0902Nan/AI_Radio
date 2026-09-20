import type { INestApplication } from '@nestjs/common'
import type { DbService as DbType } from '../../apps/api/dist/persistence/db.service.js'
import type { DjPipelineService as PipelineType } from '../../apps/api/dist/dj/dj-pipeline.service.js'
import type { NeteaseService as NeteaseType } from '../../apps/api/dist/music/netease.service.js'
const test: typeof import('node:test') = require('node:test')
const assert: typeof import('node:assert/strict') = require('node:assert/strict')
const fs: typeof import('node:fs') = require('node:fs')
const os: typeof import('node:os') = require('node:os')
const path: typeof import('node:path') = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-dj-order-'))
process.env.RADIO_DB_FILE = path.join(dir, 'radio.db')
process.env.DJ_AUDIO_CACHE_DIR = path.join(dir, 'audio')
process.env.RADIO_SESSION_FILE = path.join(dir, 'session.json')
require('reflect-metadata')
const { DatabaseSync }: typeof import('node:sqlite') = require('node:sqlite')
// Simulate an existing database predating the ordering columns.
const legacy = new DatabaseSync(process.env.RADIO_DB_FILE)
legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, adjustments TEXT NOT NULL DEFAULT '{}')")
legacy.close()
const { NestFactory }: typeof import('@nestjs/core') = require('@nestjs/core')
const { AppModule }: typeof import('../../apps/api/dist/app.module.js') = require('../../apps/api/dist/app.module.js')
const { DbService }: { DbService: typeof DbType } = require('../../apps/api/dist/persistence/db.service.js')
const { DjPipelineService }: { DjPipelineService: typeof PipelineType } = require('../../apps/api/dist/dj/dj-pipeline.service.js')
const { NeteaseService }: { NeteaseService: typeof NeteaseType } = require('../../apps/api/dist/music/netease.service.js')
let app: INestApplication
let base = ''
async function launch() {
  app = await NestFactory.create(AppModule, { logger: false })
  // Missing voice configuration short-circuits preparation without external providers.
  app.get(DbService).setSetting('djVoiceReferenceId', '')
  app.get(NeteaseService).resolveTrack = async () => { throw new Error('unexpected provider invocation') }
  await app.listen(0, '127.0.0.1')
  base = await app.getUrl()
}
async function post(route: string, body: unknown) {
  const response = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value: unknown = await response.json()
  assert.ok(value && typeof value === 'object')
  return { status: response.status, body: value as Record<string, unknown> }
}
async function close() { app.get(DjPipelineService)._dispose(); await app.close() }
test.before(launch)
test.after(async () => {
  await close()
  const trash = path.join(os.homedir(), '.Trash'); fs.mkdirSync(trash, { recursive: true })
  fs.renameSync(dir, path.join(trash, path.basename(dir)))
})
test('真实 HTTP 校验会话、顺序、重启持久性及旧库默认值', async () => {
  const db = app.get(DbService)
  const session = db.startSession()
  assert.equal(session.highest_epoch, 0)
  assert.equal(session.transition_seq, -1)
  const request = { sessionId: session.id, epoch: 8, transitionSeq: 2, transitionId: 'transition', fromItemId: 'from', targetItemId: 'target', targetTrackId: 12 }
  assert.equal((await post('dj/prepare', { ...request, transitionSeq: undefined })).status, 400)
  assert.equal((await post('dj/prepare', { ...request, sessionId: 'missing' })).status, 409)
  assert.equal((await post('dj/prepare', request)).status, 200)
  assert.equal((await post('dj/prepare', request)).status, 200)
  assert.equal((await post('dj/prepare', { ...request, brief: 'different' })).body.code, 'payload_conflict')
  await close(); await launch()
  assert.equal(app.get(DbService).getOpenSession()?.highest_epoch, 8)
  assert.equal((await post('dj/prepare', { ...request, epoch: 7 })).body.code, 'stale_epoch')
  assert.equal((await post('dj/prepare', { ...request, transitionSeq: 1 })).body.code, 'stale_epoch')
  assert.equal((await post('dj/prepare', { ...request, brief: 'different' })).body.code, 'payload_conflict')
  assert.equal((await post('session/stop', {})).status, 200)
  assert.equal((await post('dj/prepare', request)).body.code, 'session_ended')
  const next = app.get(DbService).startSession()
  assert.equal((await post('dj/prepare', { ...request, sessionId: next.id, epoch: 0, transitionSeq: 0 })).status, 200)
  assert.equal((await post('dj/prepare', request)).body.code, 'session_ended')
})
